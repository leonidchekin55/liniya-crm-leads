const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const state = { leads: [], tags: [], filter: 'all', tag: '', query: '' };

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить действие.');
  return data;
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 2600);
}

function closeModal() { $('#modalback').classList.remove('open'); }
function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modalback').classList.add('open');
  $('#modal input, #modal textarea, #modal select')?.focus();
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(value));
}

function visibleLeads() {
  return state.leads.filter((lead) => {
    const matchStatus = state.filter !== 'new' || lead.status === 'new';
    const matchSource = !['Веб-сайт', 'Telegram'].includes(state.filter) ||
      (state.filter === 'Telegram' ? lead.source.startsWith('Telegram') : lead.source === state.filter);
    const matchTag = !state.tag || lead.tags.includes(state.tag);
    const query = state.query.toLowerCase();
    const matchQuery = !query || `${lead.name} ${lead.contact} ${lead.request}`.toLowerCase().includes(query);
    return matchStatus && matchSource && matchTag && matchQuery;
  });
}

function render() {
  const leads = visibleLeads();
  $('#tbody').innerHTML = leads.map((lead) => {
    const tagHtml = lead.tags.map((tag) => `<span class="tag ${tag === 'Горячий' ? 'hot' : tag === 'Новый' ? 'new' : ''}">${esc(tag)}</span>`).join(' ');
    const statusName = { new: 'Новый', work: 'В работе', wait: 'Ожидает' }[lead.status] || 'Новый';
    return `<tr>
      <td><div class="leadname">${esc(lead.name)}</div><div class="contact">${esc(lead.contact)}</div></td>
      <td class="request">${esc(lead.request)}</td>
      <td>${tagHtml || '<span class="source">Без тегов</span>'}<div><select aria-label="Статус лида" class="status-select" data-status="${lead.id}"><option value="new" ${lead.status === 'new' ? 'selected' : ''}>Новый</option><option value="work" ${lead.status === 'work' ? 'selected' : ''}>В работе</option><option value="wait" ${lead.status === 'wait' ? 'selected' : ''}>Ожидает</option></select><button class="edit-tags" data-edit-tags="${lead.id}" type="button">Изменить теги</button></div></td>
      <td class="source">${esc(lead.source)}</td><td class="source">${formatDate(lead.created_at)}</td>
      <td><button class="dots" aria-label="Удалить лид ${esc(lead.name)}" data-del="${lead.id}" style="border:0;background:none">•••</button></td>
    </tr>`;
  }).join('');
  $('#empty').hidden = leads.length > 0;
  $('#shown').textContent = `${leads.length} ${leads.length === 1 ? 'запись' : 'записей'}`;
  $('#totalStat').textContent = state.leads.length;
  $('#newStat').textContent = state.leads.filter((lead) => lead.status === 'new').length;
  $('#workStat').textContent = state.leads.filter((lead) => lead.status === 'work').length;
  $('#tgStat').textContent = state.leads.filter((lead) => lead.source.startsWith('Telegram')).length;
  $('#taglist').innerHTML = state.tags.map((tag) => `<button type="button" class="tagrow" data-tf="${esc(tag.name)}" aria-pressed="${state.tag === tag.name}"><span class="tagdot"></span><span class="taglabel">${esc(tag.name)}</span><span class="count">${tag.count}</span></button>`).join('') +
    (state.tag ? '<div style="padding-top:9px"><button class="pill active" id="clearTag">Сбросить тег ×</button></div>' : '');
}

async function refresh() {
  const [leadData, tagData] = await Promise.all([api('/api/leads'), api('/api/tags')]);
  state.leads = leadData.leads;
  state.tags = tagData.tags;
  render();
}

function showDashboard() {
  document.body.classList.add('auth-ready');
  $('#loginback').classList.remove('open');
  $('#logoutBtn').hidden = false;
  refresh().catch((error) => toast(error.message));
  refreshBotStatus();
}

async function refreshBotStatus() {
  try {
    const status = await api('/api/telegram/status');
    const badge = $('#botStatus');
    const note = $('#botNote');
    if (!status.configured) {
      badge.textContent = 'НЕ НАСТРОЕН';
      badge.style.color = '#a27431';
      note.textContent = 'Добавьте токен Telegram-бота в защищённые настройки Cloudflare, затем нажмите «Настроить Telegram».';
    } else if (status.webhook) {
      badge.textContent = 'ПОДКЛЮЧЁН';
      badge.style.color = 'var(--green)';
      note.textContent = `Подключён @${status.username}. Новые заявки появятся в общей базе автоматически.`;
    } else {
      badge.textContent = 'ГОТОВ К НАСТРОЙКЕ';
      badge.style.color = '#a27431';
      note.textContent = `Бот @${status.username} найден. Нажмите «Настроить Telegram», чтобы включить приём заявок.`;
    }
  } catch { $('#botNote').textContent = 'Не удалось проверить Telegram. Обновите страницу или попробуйте позже.'; }
}

function leadForm() {
  if (!state.tags.length) return toast('Сначала создайте тег.');
  openModal(`<h2>Новый лид</h2><p>Заполните данные обращения и назначьте тег.</p>
    <form id="leadForm"><label class="field"><span>Имя</span><input name="name" placeholder="Например, Анна" maxlength="120" required></label>
    <label class="field"><span>Контакт</span><input name="contact" placeholder="@username, телефон или email" maxlength="180" required></label>
    <label class="field"><span>Запрос</span><textarea name="request" placeholder="Что нужно клиенту?" maxlength="3000" required></textarea></label>
    <label class="field"><span>Тег</span><select name="tag">${state.tags.map((tag) => `<option value="${esc(tag.name)}">${esc(tag.name)}</option>`).join('')}</select></label>
    <div class="modalactions"><button type="button" class="btn" id="cancel">Отмена</button><button class="btn primary">Сохранить лид</button></div></form>`);
  $('#cancel').onclick = closeModal;
  $('#leadForm').onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try { await api('/api/leads', { method: 'POST', body: JSON.stringify(data) }); await refresh(); closeModal(); toast('Лид добавлен в общую CRM.'); }
    catch (error) { toast(error.message); }
  };
}

function tagForm() {
  openModal(`<h2>Новый тег</h2><p>Тег появится в фильтрах и форме добавления лида.</p>
    <form id="tagForm"><label class="field"><span>Название тега</span><input name="name" placeholder="Например, Партнёр" maxlength="40" required></label>
    <div class="modalactions"><button type="button" class="btn" id="cancel">Отмена</button><button class="btn primary">Создать тег</button></div></form>`);
  $('#cancel').onclick = closeModal;
  $('#tagForm').onsubmit = async (event) => {
    event.preventDefault();
    try { await api('/api/tags', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); await refresh(); closeModal(); toast('Тег создан.'); }
    catch (error) { toast(error.message); }
  };
}

function editLeadTags(id) {
  const lead = state.leads.find((item) => String(item.id) === String(id));
  if (!lead) return;
  openModal(`<h2>Теги лида</h2><p>${esc(lead.name)} · выберите до пяти тегов.</p><form id="editTagsForm">
    ${state.tags.map((tag) => `<label class="field" style="display:flex;align-items:center;gap:9px"><input type="checkbox" name="tags" value="${esc(tag.name)}" ${lead.tags.includes(tag.name) ? 'checked' : ''}><span style="margin:0">${esc(tag.name)}</span></label>`).join('')}
    <div class="modalactions"><button type="button" class="btn" id="cancel">Отмена</button><button class="btn primary">Сохранить</button></div></form>`);
  $('#cancel').onclick = closeModal;
  $('#editTagsForm').onsubmit = async (event) => {
    event.preventDefault();
    const tags = [...event.currentTarget.querySelectorAll('[name="tags"]:checked')].map((input) => input.value);
    try { await api(`/api/leads/${id}/tags`, { method: 'PATCH', body: JSON.stringify({ tags }) }); await refresh(); closeModal(); toast('Теги обновлены.'); }
    catch (error) { toast(error.message); }
  };
}

$('#loginForm').onsubmit = async (event) => {
  event.preventDefault();
  $('#loginError').textContent = '';
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) }); $('#password').value = ''; showDashboard(); }
  catch (error) { $('#loginError').textContent = error.message; }
};

$('#logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {}); location.reload(); };
$('#addBtn').onclick = leadForm;
$('#botBtn').onclick = async () => {
  $('#botBtn').disabled = true;
  try { const result = await api('/api/telegram/setup', { method: 'POST', body: '{}' }); toast(`Подключён @${result.username}.`); await refreshBotStatus(); }
  catch (error) { toast(error.message); }
  finally { $('#botBtn').disabled = false; }
};
$('#tagBtn').onclick = tagForm;
$('#search').oninput = (event) => { state.query = event.target.value; render(); };
document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button));
  state.filter = button.dataset.filter; state.tag = ''; render();
}));
$('#taglist').onclick = (event) => {
  const row = event.target.closest('[data-tf]');
  if (row) { state.tag = state.tag === row.dataset.tf ? '' : row.dataset.tf; state.filter = 'all'; document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item.dataset.filter === 'all')); render(); }
  if (event.target.id === 'clearTag') { state.tag = ''; render(); }
};
$('#tbody').addEventListener('change', async (event) => {
  const select = event.target.closest('[data-status]');
  if (!select) return;
  try { await api(`/api/leads/${select.dataset.status}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) }); await refresh(); }
  catch (error) { toast(error.message); await refresh(); }
});
$('#tbody').addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-edit-tags]');
  if (edit) return editLeadTags(edit.dataset.editTags);
  const remove = event.target.closest('[data-del]');
  if (remove && confirm('Удалить лид из общей CRM?')) {
    try { await api(`/api/leads/${remove.dataset.del}`, { method: 'DELETE' }); await refresh(); toast('Лид удалён.'); }
    catch (error) { toast(error.message); }
  }
});
$('#modalback').onclick = (event) => { if (event.target.id === 'modalback') closeModal(); };
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });

async function init() {
  try {
    const session = await api('/api/session');
    if (session.authorized) showDashboard();
    else { document.body.classList.add('auth-ready'); $('#loginback').classList.add('open'); $('#password').focus(); }
  } catch {
    document.body.classList.add('auth-ready');
    $('#loginback').classList.add('open');
    $('#loginError').textContent = 'Сервис базы пока недоступен. Попробуйте обновить страницу позже.';
  }
}
init();
