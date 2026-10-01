import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const here = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(here, 'public');
const schema = await readFile(join(here, 'db/schema.sql'), 'utf8');
const port = Number(process.env.PORT || 10000);
const sessionSecret = process.env.SESSION_SECRET;
const adminPassword = process.env.ADMIN_PASSWORD;
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
const maxBody = 32 * 1024;

if (!process.env.DATABASE_URL || !sessionSecret || !adminPassword || !webhookSecret) {
  throw new Error('Required production configuration is missing.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000 });
const sessions = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

function safeEqual(a, b) {
  const aa = createHash('sha256').update(String(a)).digest();
  const bb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(aa, bb);
}

function signedCookie(value) {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function readSession(req) {
  const raw = (req.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith('liniya_session='))?.slice('liniya_session='.length);
  if (!raw) return false;
  const [encoded, signature] = raw.split('.');
  if (!encoded || !signature) return false;
  const expected = createHmac('sha256', sessionSecret).update(encoded).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return false; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return value.exp > Date.now() && value.user === 'admin';
  } catch { return false; }
}

function setSessionCookie(res, value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' || process.env.RENDER_EXTERNAL_URL?.startsWith('https://');
  res.setHeader('set-cookie', `liniya_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Некорректные данные формы'), { status: 400 }); }
}

function clean(value, max) { return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max); }

function sameOrigin(req, url) {
  const origin = req.headers.origin;
  return !origin || origin === url.origin;
}

async function telegram(method, payload = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${telegramToken}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.description || 'Telegram API error');
    return result.result;
  } finally { clearTimeout(timeout); }
}

async function createTelegramLead(updateId, name, contact, request) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO leads(name, contact, request, source, status, telegram_update_id)
       VALUES ($1, $2, $3, 'Telegram-бот', 'new', $4)
       ON CONFLICT (telegram_update_id) DO NOTHING RETURNING id`,
      [name, contact, request, updateId],
    );
    if (inserted.rowCount) {
      await client.query(`INSERT INTO lead_tags(lead_id, tag_id) SELECT $1, id FROM tags WHERE name='Новый' ON CONFLICT DO NOTHING`, [inserted.rows[0].id]);
    }
    await client.query('COMMIT');
    return inserted.rowCount > 0;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function handleTelegramUpdate(update) {
  const message = update?.message;
  if (!message?.chat?.id || typeof message.text !== 'string') return;
  const chatId = message.chat.id;
  const text = clean(message.text, 3000);
  if (!text) return;
  if (text === '/start' || text === '/restart' || text.startsWith('/start ')) {
    await pool.query(`INSERT INTO telegram_sessions(chat_id,step,name,contact) VALUES($1,'name',NULL,NULL)
      ON CONFLICT(chat_id) DO UPDATE SET step='name',name=NULL,contact=NULL,updated_at=now()`, [chatId]);
    await telegram('sendMessage', { chat_id: chatId, text: 'Здравствуйте! Я помогу передать заявку в агентство. Отправляя имя, контакт и запрос, вы соглашаетесь передать эти данные в CRM агентства для ответа по обращению.\n\nКак вас зовут?' });
    return;
  }
  const result = await pool.query('SELECT step,name,contact FROM telegram_sessions WHERE chat_id=$1', [chatId]);
  const flow = result.rows[0];
  if (!flow) {
    await telegram('sendMessage', { chat_id: chatId, text: 'Чтобы начать новую заявку, отправьте /start.' });
    return;
  }
  if (text.startsWith('/')) {
    await telegram('sendMessage', { chat_id: chatId, text: 'Чтобы начать заново, отправьте /start.' });
    return;
  }
  if (flow.step === 'name') {
    if (text.length < 2) return telegram('sendMessage', { chat_id: chatId, text: 'Пожалуйста, напишите имя чуть подробнее.' });
    await pool.query(`UPDATE telegram_sessions SET step='contact',name=$2,updated_at=now() WHERE chat_id=$1`, [chatId, text.slice(0, 120)]);
    await telegram('sendMessage', { chat_id: chatId, text: 'Как с вами связаться? Пришлите телефон, email или @username.' });
    return;
  }
  if (flow.step === 'contact') {
    if (text.length < 3) return telegram('sendMessage', { chat_id: chatId, text: 'Контакт слишком короткий. Пришлите телефон, email или @username.' });
    await pool.query(`UPDATE telegram_sessions SET step='request',contact=$2,updated_at=now() WHERE chat_id=$1`, [chatId, text.slice(0, 180)]);
    await telegram('sendMessage', { chat_id: chatId, text: 'Опишите, пожалуйста, ваш запрос. До 3000 символов.' });
    return;
  }
  if (flow.step === 'request') {
    if (text.length < 4) return telegram('sendMessage', { chat_id: chatId, text: 'Добавьте немного подробностей, чтобы менеджер понял задачу.' });
    const inserted = await createTelegramLead(update.update_id, flow.name, flow.contact, text);
    await pool.query('DELETE FROM telegram_sessions WHERE chat_id=$1', [chatId]);
    await telegram('sendMessage', { chat_id: chatId, text: inserted ? 'Спасибо! Заявка сохранена, менеджер свяжется с вами по указанному контакту.' : 'Эта заявка уже была принята. Спасибо!' });
  }
}

async function api(req, res, url) {
  const path = url.pathname;
  if (req.method === 'GET' && path === '/api/session') return json(res, 200, { authorized: readSession(req), botConfigured: Boolean(telegramToken) });
  if (req.method === 'POST' && path === '/api/login') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    const current = sessions.get(ip) || { count: 0, until: Date.now() + 60000 };
    if (current.until < Date.now()) { current.count = 0; current.until = Date.now() + 60000; }
    if (current.count >= 10) return json(res, 429, { error: 'Слишком много попыток. Попробуйте позже.' });
    const data = await bodyJson(req);
    if (!safeEqual(data.password || '', adminPassword)) {
      current.count += 1; sessions.set(ip, current);
      return json(res, 401, { error: 'Неверный пароль.' });
    }
    sessions.delete(ip);
    setSessionCookie(res, signedCookie({ user: 'admin', exp: Date.now() + 7 * 86400000, nonce: randomBytes(12).toString('hex') }), 7 * 86400);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && path === '/api/logout') {
    setSessionCookie(res, '', 0);
    return json(res, 200, { ok: true });
  }
  if (!readSession(req)) return json(res, 401, { error: 'Нужно войти в CRM.' });

  if (req.method === 'GET' && path === '/api/leads') {
    const q = clean(url.searchParams.get('q'), 120);
    const source = clean(url.searchParams.get('source'), 80);
    const status = clean(url.searchParams.get('status'), 20);
    const tag = clean(url.searchParams.get('tag'), 40);
    const values = [];
    const filters = [];
    if (q) { values.push(`%${q}%`); filters.push(`(l.name ILIKE $${values.length} OR l.contact ILIKE $${values.length} OR l.request ILIKE $${values.length})`); }
    if (source) { values.push(source === 'Telegram' ? 'Telegram%' : source); filters.push(`l.source ${source === 'Telegram' ? 'ILIKE' : '='} $${values.length}`); }
    if (status) { values.push(status); filters.push(`l.status=$${values.length}`); }
    if (tag) { values.push(tag); filters.push(`EXISTS(SELECT 1 FROM lead_tags ft JOIN tags fg ON fg.id=ft.tag_id WHERE ft.lead_id=l.id AND fg.name=$${values.length})`); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(`SELECT l.id,l.name,l.contact,l.request,l.source,l.status,l.created_at,
      COALESCE(array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL),'{}') AS tags
      FROM leads l LEFT JOIN lead_tags lt ON lt.lead_id=l.id LEFT JOIN tags t ON t.id=lt.tag_id
      ${where} GROUP BY l.id ORDER BY l.created_at DESC LIMIT 500`, values);
    return json(res, 200, { leads: result.rows });
  }
  if (req.method === 'POST' && path === '/api/leads') {
    const data = await bodyJson(req);
    const name = clean(data.name, 120), contact = clean(data.contact, 180), request = clean(data.request, 3000), tag = clean(data.tag, 40);
    if (name.length < 2 || contact.length < 3 || request.length < 4) return json(res, 400, { error: 'Проверьте имя, контакт и описание запроса.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query(`INSERT INTO leads(name,contact,request,source,status) VALUES($1,$2,$3,'Ручное добавление','new') RETURNING id`, [name, contact, request]);
      if (tag) {
        const tagRow = await client.query('SELECT id FROM tags WHERE name=$1', [tag]);
        if (!tagRow.rowCount) throw Object.assign(new Error('Выберите существующий тег.'), { status: 400 });
        await client.query('INSERT INTO lead_tags(lead_id,tag_id) VALUES($1,$2)', [row.rows[0].id, tagRow.rows[0].id]);
      }
      await client.query('COMMIT');
      return json(res, 201, { ok: true });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  if (req.method === 'GET' && path === '/api/tags') {
    const result = await pool.query(`SELECT t.id,t.name,count(lt.lead_id)::int AS count FROM tags t LEFT JOIN lead_tags lt ON lt.tag_id=t.id GROUP BY t.id ORDER BY t.id`);
    return json(res, 200, { tags: result.rows });
  }
  if (req.method === 'POST' && path === '/api/tags') {
    const data = await bodyJson(req), name = clean(data.name, 40);
    if (name.length < 2) return json(res, 400, { error: 'Название тега должно содержать хотя бы 2 символа.' });
    const result = await pool.query('INSERT INTO tags(name) VALUES($1) ON CONFLICT(name) DO NOTHING RETURNING id', [name]);
    if (!result.rowCount) return json(res, 409, { error: 'Такой тег уже существует.' });
    return json(res, 201, { ok: true });
  }
  const leadRoute = path.match(/^\/api\/leads\/(\d+)(?:\/(tags))?$/);
  if (leadRoute && req.method === 'PATCH' && leadRoute[2] !== 'tags') {
    const data = await bodyJson(req);
    if (!['new', 'work', 'wait'].includes(data.status)) return json(res, 400, { error: 'Неизвестный статус.' });
    const result = await pool.query('UPDATE leads SET status=$2 WHERE id=$1', [leadRoute[1], data.status]);
    return json(res, result.rowCount ? 200 : 404, result.rowCount ? { ok: true } : { error: 'Лид не найден.' });
  }
  if (leadRoute && req.method === 'PATCH' && leadRoute[2] === 'tags') {
    const data = await bodyJson(req), tags = Array.isArray(data.tags) ? [...new Set(data.tags.map((x) => clean(x, 40)))] : [];
    if (tags.length > 5) return json(res, 400, { error: 'Можно назначить не больше пяти тегов.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lead = await client.query('SELECT id FROM leads WHERE id=$1 FOR UPDATE', [leadRoute[1]]);
      if (!lead.rowCount) throw Object.assign(new Error('Лид не найден.'), { status: 404 });
      const selected = tags.length ? await client.query('SELECT id,name FROM tags WHERE name=ANY($1::text[])', [tags]) : { rows: [] };
      if (selected.rows.length !== tags.length) throw Object.assign(new Error('Один из тегов не найден.'), { status: 400 });
      await client.query('DELETE FROM lead_tags WHERE lead_id=$1', [leadRoute[1]]);
      for (const t of selected.rows) await client.query('INSERT INTO lead_tags(lead_id,tag_id) VALUES($1,$2)', [leadRoute[1], t.id]);
      await client.query('COMMIT');
      return json(res, 200, { ok: true });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  if (leadRoute && req.method === 'DELETE') {
    const result = await pool.query('DELETE FROM leads WHERE id=$1', [leadRoute[1]]);
    return json(res, result.rowCount ? 200 : 404, result.rowCount ? { ok: true } : { error: 'Лид не найден.' });
  }
  if (req.method === 'GET' && path === '/api/telegram/status') {
    if (!telegramToken) return json(res, 200, { configured: false, webhook: false });
    const [me, info] = await Promise.all([telegram('getMe'), telegram('getWebhookInfo')]);
    return json(res, 200, { configured: true, username: me.username, webhook: info.url === `${process.env.RENDER_EXTERNAL_URL}/telegram/webhook` });
  }
  if (req.method === 'POST' && path === '/api/telegram/setup') {
    if (!telegramToken) return json(res, 409, { error: 'Добавьте токен бота в переменные сайта Render.' });
    const me = await telegram('getMe');
    const info = await telegram('getWebhookInfo');
    const target = `${process.env.RENDER_EXTERNAL_URL}/telegram/webhook`;
    if (info.url && info.url !== target) return json(res, 409, { error: 'У этого бота уже настроен другой webhook. Сначала проверьте его назначение в Telegram.' });
    await telegram('setWebhook', { url: target, secret_token: webhookSecret, allowed_updates: ['message'], drop_pending_updates: false });
    return json(res, 200, { ok: true, username: me.username });
  }
  return json(res, 404, { error: 'Не найдено.' });
}

async function handler(req, res) {
  const url = new URL(req.url, process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");

  if (req.method === 'OPTIONS') { res.writeHead(204, { allow: 'GET, POST, PATCH, DELETE, OPTIONS' }); return res.end(); }
  if (url.pathname.startsWith('/api/') && ['POST', 'PATCH', 'DELETE'].includes(req.method) && !sameOrigin(req, url)) return json(res, 403, { error: 'Запрос отклонён.' });
  if (req.method === 'GET' && url.pathname === '/health/ready') {
    try { await pool.query('SELECT 1'); return json(res, 200, { status: 'ok' }); }
    catch { return json(res, 503, { status: 'unavailable' }); }
  }
  if (req.method === 'POST' && url.pathname === '/telegram/webhook') {
    if (!safeEqual(req.headers['x-telegram-bot-api-secret-token'] || '', webhookSecret)) return json(res, 403, { error: 'Forbidden.' });
    try {
      const update = await bodyJson(req);
      if (!Number.isSafeInteger(update.update_id)) return json(res, 400, { error: 'Invalid update.' });
      const stored = await pool.query('INSERT INTO telegram_updates(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id', [update.update_id]);
      if (!stored.rowCount) return json(res, 200, { ok: true });
      try { await handleTelegramUpdate(update); }
      catch (error) {
        await pool.query('DELETE FROM telegram_updates WHERE update_id=$1', [update.update_id]);
        throw error;
      }
      return json(res, 200, { ok: true });
    } catch (error) { console.error('Telegram webhook failed:', error.message); return json(res, error.status || 500, { error: 'Webhook processing failed.' }); }
  }
  if (url.pathname.startsWith('/api/')) {
    try { return await api(req, res, url); }
    catch (error) { console.error('API request failed:', error.message); return json(res, error.status || 500, { error: error.status ? error.message : 'Не удалось обработать запрос. Попробуйте ещё раз.' }); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Метод не поддерживается.' }, { allow: 'GET, HEAD' });
  const relative = url.pathname === '/' ? 'index.html' : normalize(decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (relative.startsWith('..')) return json(res, 400, { error: 'Некорректный путь.' });
  const file = join(publicDir, relative);
  try {
    if (!(await stat(file)).isFile()) throw new Error('Not a file');
    const bytes = await readFile(file);
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': ['index.html', 'app.js'].includes(relative) ? 'no-cache' : 'public, max-age=3600' });
    return req.method === 'HEAD' ? res.end() : res.end(bytes);
  } catch { return json(res, 404, { error: 'Не найдено.' }); }
}

await pool.query(schema);
const server = createServer((req, res) => { handler(req, res).catch((error) => { console.error('Request failed:', error.message); if (!res.headersSent) json(res, 500, { error: 'Внутренняя ошибка сервера.' }); else res.end(); }); });
server.listen(port, '0.0.0.0', () => console.log(`Линия CRM listening on ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => pool.end().finally(() => process.exit(0))); });
