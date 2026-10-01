const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const clean = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
function b64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64url(value) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), (c) => c.charCodeAt(0)); }
async function authorized(request, env) {
  const raw = (request.headers.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith('liniya_session='))?.slice(15);
  if (!raw || !env.SESSION_SECRET) return false;
  const [payload, signature] = raw.split('.');
  if (!payload || !signature) return false;
  try {
    const expected = b64url(await hmac(env.SESSION_SECRET, payload));
    const a = encoder.encode(signature), b = encoder.encode(expected);
    if (a.length !== b.length) return false;
    let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; if (diff) return false;
    const value = JSON.parse(decoder.decode(unb64url(payload)));
    return value.user === 'admin' && value.exp > Date.now();
  } catch { return false; }
}
async function makeSession(env) {
  const payload = b64url(encoder.encode(JSON.stringify({ user: 'admin', exp: Date.now() + 7 * 86400000, nonce: crypto.randomUUID() })));
  return `${payload}.${b64url(await hmac(env.SESSION_SECRET, payload))}`;
}
async function readBody(request) {
  const raw = await request.text();
  if (raw.length > 32768) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
  try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('Некорректные данные формы'), { status: 400 }); }
}
function passwordMatches(input, expected) {
  if (typeof input !== 'string' || input.length > 300 || typeof expected !== 'string') return false;
  const a = encoder.encode(input), b = encoder.encode(expected);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
function originAllowed(request, url) { const origin = request.headers.get('origin'); return !origin || origin === url.origin; }
async function telegram(env, method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
  const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.description || 'Telegram API error'); return data.result;
}
async function leadTags(db, id) { return (await db.prepare('SELECT t.name FROM tags t JOIN lead_tags lt ON lt.tag_id=t.id WHERE lt.lead_id=? ORDER BY t.id').bind(id).all()).results.map(x => x.name); }
async function createTelegramLead(db, updateId, name, contact, request) {
  const inserted = await db.prepare("INSERT OR IGNORE INTO leads(name,contact,request,source,status,telegram_update_id) VALUES(?,?,?, 'Telegram-бот','new',?)").bind(name, contact, request, updateId).run();
  if (inserted.meta.changes) await db.prepare("INSERT OR IGNORE INTO lead_tags(lead_id,tag_id) SELECT ?,id FROM tags WHERE name='Новый'").bind(inserted.meta.last_row_id).run();
  return inserted.meta.changes > 0;
}
async function handleTelegramUpdate(update, env) {
  const message = update?.message; if (!message?.chat?.id || typeof message.text !== 'string') return;
  const chatId = message.chat.id, text = clean(message.text, 3000); if (!text) return;
  if (text === '/start' || text === '/restart' || text.startsWith('/start ')) {
    await env.DB.prepare("INSERT INTO telegram_sessions(chat_id,step,name,contact) VALUES(?,'name',NULL,NULL) ON CONFLICT(chat_id) DO UPDATE SET step='name',name=NULL,contact=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(chatId).run();
    await telegram(env, 'sendMessage', { chat_id: chatId, text: 'Здравствуйте! Я помогу передать заявку в агентство. Отправляя имя, контакт и запрос, вы соглашаетесь передать эти данные в CRM агентства для ответа по обращению.\n\nКак вас зовут?' }); return;
  }
  const flow = await env.DB.prepare('SELECT step,name,contact FROM telegram_sessions WHERE chat_id=?').bind(chatId).first();
  if (!flow) return telegram(env, 'sendMessage', { chat_id: chatId, text: 'Чтобы начать новую заявку, отправьте /start.' });
  if (text.startsWith('/')) return telegram(env, 'sendMessage', { chat_id: chatId, text: 'Чтобы начать заново, отправьте /start.' });
  if (flow.step === 'name') {
    if (text.length < 2) return telegram(env, 'sendMessage', { chat_id: chatId, text: 'Пожалуйста, напишите имя чуть подробнее.' });
    await env.DB.prepare("UPDATE telegram_sessions SET step='contact',name=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=?").bind(text.slice(0, 120), chatId).run();
    return telegram(env, 'sendMessage', { chat_id: chatId, text: 'Как с вами связаться? Пришлите телефон, email или @username.' });
  }
  if (flow.step === 'contact') {
    if (text.length < 3) return telegram(env, 'sendMessage', { chat_id: chatId, text: 'Контакт слишком короткий. Пришлите телефон, email или @username.' });
    await env.DB.prepare("UPDATE telegram_sessions SET step='request',contact=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE chat_id=?").bind(text.slice(0, 180), chatId).run();
    return telegram(env, 'sendMessage', { chat_id: chatId, text: 'Опишите, пожалуйста, ваш запрос. До 3000 символов.' });
  }
  if (text.length < 4) return telegram(env, 'sendMessage', { chat_id: chatId, text: 'Добавьте немного подробностей, чтобы менеджер понял задачу.' });
  const inserted = await createTelegramLead(env.DB, update.update_id, flow.name, flow.contact, text);
  await env.DB.prepare('DELETE FROM telegram_sessions WHERE chat_id=?').bind(chatId).run();
  await telegram(env, 'sendMessage', { chat_id: chatId, text: inserted ? 'Спасибо! Заявка сохранена, менеджер свяжется с вами по указанному контакту.' : 'Эта заявка уже была принята. Спасибо!' });
}

async function api(request, env, url) {
  const path = url.pathname, method = request.method;
  const db = env.DB;
  if (method === 'GET' && path === '/api/session') return json({ authorized: await authorized(request, env), botConfigured: Boolean(env.TELEGRAM_BOT_TOKEN) });
  if (method === 'POST' && path === '/api/login') {
    if (!env.ADMIN_PASSWORD) return json({ error: 'Владелец ещё не настроил пароль CRM в Cloudflare.' }, 503);
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const ipKey = b64url(await hmac(env.SESSION_SECRET, ip));
    const now = Date.now(), resetAt = now + 60000;
    const attempts = await db.prepare(`INSERT INTO login_attempts(ip_key,attempts,reset_at) VALUES(?,1,?)
      ON CONFLICT(ip_key) DO UPDATE SET
        attempts=CASE WHEN reset_at<=? THEN 1 ELSE attempts+1 END,
        reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END
      RETURNING attempts`).bind(ipKey, resetAt, now, now, resetAt).first();
    if (attempts?.attempts > 10) return json({ error: 'Слишком много попыток. Подождите минуту и попробуйте снова.' }, 429);
    const data = await readBody(request);
    if (!passwordMatches(data.password, env.ADMIN_PASSWORD)) return json({ error: 'Неверный пароль.' }, 401);
    await db.prepare('DELETE FROM login_attempts WHERE ip_key=?').bind(ipKey).run();
    const cookie = await makeSession(env);
    return json({ ok: true }, 200, { 'set-cookie': `liniya_session=${cookie}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800` });
  }
  if (method === 'POST' && path === '/api/logout') return json({ ok: true }, 200, { 'set-cookie': 'liniya_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  if (!await authorized(request, env)) return json({ error: 'Нужно войти в CRM.' }, 401);
  if (method === 'GET' && path === '/api/leads') {
    const q = clean(url.searchParams.get('q'), 120), source = clean(url.searchParams.get('source'), 80), status = clean(url.searchParams.get('status'), 20), tag = clean(url.searchParams.get('tag'), 40);
    const clauses = [], values = [];
    if (q) { clauses.push('(l.name LIKE ? COLLATE NOCASE OR l.contact LIKE ? COLLATE NOCASE OR l.request LIKE ? COLLATE NOCASE)'); values.push(`%${q}%`,`%${q}%`,`%${q}%`); }
    if (source) { clauses.push(source === 'Telegram' ? 'l.source LIKE ?' : 'l.source=?'); values.push(source === 'Telegram' ? 'Telegram%' : source); }
    if (status) { clauses.push('l.status=?'); values.push(status); }
    if (tag) { clauses.push('EXISTS(SELECT 1 FROM lead_tags ft JOIN tags fg ON fg.id=ft.tag_id WHERE ft.lead_id=l.id AND fg.name=?)'); values.push(tag); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await db.prepare(`SELECT l.* FROM leads l ${where} ORDER BY l.created_at DESC LIMIT 500`).bind(...values).all();
    const leads = await Promise.all(result.results.map(async row => ({ ...row, tags: await leadTags(db, row.id) })));
    return json({ leads });
  }
  if (method === 'POST' && path === '/api/leads') {
    const data = await readBody(request), name = clean(data.name,120), contact = clean(data.contact,180), req = clean(data.request,3000), tag = clean(data.tag,40);
    if (name.length < 2 || contact.length < 3 || req.length < 4) return json({ error:'Проверьте имя, контакт и описание запроса.' },400);
    const tagRow = tag ? await db.prepare('SELECT id FROM tags WHERE name=?').bind(tag).first() : null;
    if (tag && !tagRow) return json({ error:'Выберите существующий тег.' },400);
    const inserted = await db.prepare("INSERT INTO leads(name,contact,request,source,status) VALUES(?,?,?, 'Ручное добавление','new')").bind(name,contact,req).run();
    if (tagRow) await db.prepare('INSERT INTO lead_tags(lead_id,tag_id) VALUES(?,?)').bind(inserted.meta.last_row_id,tagRow.id).run();
    return json({ ok:true },201);
  }
  if (method === 'GET' && path === '/api/tags') {
    const result = await db.prepare('SELECT t.id,t.name,count(lt.lead_id) AS count FROM tags t LEFT JOIN lead_tags lt ON lt.tag_id=t.id GROUP BY t.id ORDER BY t.id').all();
    return json({ tags:result.results });
  }
  if (method === 'POST' && path === '/api/tags') {
    const data = await readBody(request), name=clean(data.name,40);
    if (name.length < 2) return json({ error:'Название тега должно содержать хотя бы 2 символа.' },400);
    const result=await db.prepare('INSERT OR IGNORE INTO tags(name) VALUES(?)').bind(name).run();
    if (!result.meta.changes) return json({ error:'Такой тег уже существует.' },409);
    return json({ ok:true },201);
  }
  const leadRoute = path.match(/^\/api\/leads\/(\d+)(?:\/(tags))?$/);
  if (leadRoute && method === 'PATCH' && !leadRoute[2]) {
    const data=await readBody(request); if (!['new','work','wait'].includes(data.status)) return json({ error:'Неизвестный статус.' },400);
    const result=await db.prepare('UPDATE leads SET status=? WHERE id=?').bind(data.status,leadRoute[1]).run();
    return json(result.meta.changes ? {ok:true} : {error:'Лид не найден.'},result.meta.changes ? 200 : 404);
  }
  if (leadRoute && method === 'PATCH' && leadRoute[2] === 'tags') {
    const data=await readBody(request), tags=Array.isArray(data.tags)?[...new Set(data.tags.map(x=>clean(x,40)))]:[];
    if (tags.length>5) return json({error:'Можно назначить не больше пяти тегов.'},400);
    const lead=await db.prepare('SELECT id FROM leads WHERE id=?').bind(leadRoute[1]).first(); if(!lead) return json({error:'Лид не найден.'},404);
    const selected=tags.length ? (await db.prepare(`SELECT id,name FROM tags WHERE name IN (${tags.map(()=>'?').join(',')})`).bind(...tags).all()).results : [];
    if(selected.length!==tags.length) return json({error:'Один из тегов не найден.'},400);
    const ops=[db.prepare('DELETE FROM lead_tags WHERE lead_id=?').bind(leadRoute[1]),...selected.map(t=>db.prepare('INSERT INTO lead_tags(lead_id,tag_id) VALUES(?,?)').bind(leadRoute[1],t.id))];
    await db.batch(ops); return json({ok:true});
  }
  if (leadRoute && method === 'DELETE') { const result=await db.prepare('DELETE FROM leads WHERE id=?').bind(leadRoute[1]).run(); return json(result.meta.changes?{ok:true}:{error:'Лид не найден.'},result.meta.changes?200:404); }
  if (method === 'GET' && path === '/api/telegram/status') {
    if(!env.TELEGRAM_BOT_TOKEN) return json({configured:false,webhook:false});
    const [me,info]=await Promise.all([telegram(env,'getMe'),telegram(env,'getWebhookInfo')]);
    return json({configured:true,username:me.username,webhook:info.url===`${url.origin}/telegram/webhook`});
  }
  if (method === 'POST' && path === '/api/telegram/setup') {
    if(!env.TELEGRAM_BOT_TOKEN) return json({error:'Добавьте токен бота в секреты Cloudflare.'},409);
    const me=await telegram(env,'getMe'),info=await telegram(env,'getWebhookInfo'),target=`${url.origin}/telegram/webhook`;
    if(info.url && info.url!==target) return json({error:'У этого бота уже настроен другой webhook. Сначала проверьте его назначение в Telegram.'},409);
    await telegram(env,'setWebhook',{url:target,secret_token:env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:['message'],drop_pending_updates:false});
    return json({ok:true,username:me.username});
  }
  return json({error:'Не найдено.'},404);
}

export default {
  async fetch(request, env) {
    const url=new URL(request.url), headers={'x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin','x-frame-options':'DENY','content-security-policy':"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"};
    if(request.method==='OPTIONS') return new Response(null,{status:204,headers:{...headers,allow:'GET, POST, PATCH, DELETE, OPTIONS'}});
    if(url.pathname.startsWith('/api/') && ['POST','PATCH','DELETE'].includes(request.method) && !originAllowed(request,url)) return json({error:'Запрос отклонён.'},403,headers);
    if(url.pathname==='/health/ready' && request.method==='GET') { try { await env.DB.prepare('SELECT 1').first(); return json({status:'ok'},200,headers); } catch { return json({status:'unavailable'},503,headers); } }
    if(url.pathname==='/telegram/webhook' && request.method==='POST') {
      const supplied=request.headers.get('x-telegram-bot-api-secret-token')||'';
      if(!env.TELEGRAM_WEBHOOK_SECRET || supplied!==env.TELEGRAM_WEBHOOK_SECRET) return json({error:'Forbidden.'},403,headers);
      try {
        const update=await readBody(request); if(!Number.isSafeInteger(update.update_id)) return json({error:'Invalid update.'},400,headers);
        const saved=await env.DB.prepare('INSERT OR IGNORE INTO telegram_updates(update_id) VALUES(?)').bind(update.update_id).run();
        if(saved.meta.changes) { try { await handleTelegramUpdate(update,env); } catch(error) { await env.DB.prepare('DELETE FROM telegram_updates WHERE update_id=?').bind(update.update_id).run(); throw error; } }
        return json({ok:true},200,headers);
      } catch(error) { console.error('Telegram webhook failed',error.message); return json({error:'Webhook processing failed.'},error.status||500,headers); }
    }
    if(url.pathname.startsWith('/api/')) {
      try { const response=await api(request,env,url); const merged=new Headers(response.headers); for(const [k,v] of Object.entries(headers)) merged.set(k,v); return new Response(response.body,{status:response.status,headers:merged}); }
      catch(error) { console.error('API error',error.message); return json({error:error.status?error.message:'Не удалось обработать запрос. Попробуйте ещё раз.'},error.status||500,headers); }
    }
    return env.ASSETS.fetch(request);
  }
};
