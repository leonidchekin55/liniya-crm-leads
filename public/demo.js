const DEMO_LEADS = [
  { name: 'Анна Светлова', contact: 'anna@example.invalid', request: 'Нужен сайт-визитка для небольшой студии.', tag: 'Новый', status: 'new', source: 'Telegram-бот', date: 'Сегодня' },
  { name: 'Михаил Тестов', contact: '@demo_mikhail', request: 'Хочу обсудить редизайн каталога услуг.', tag: 'Горячий', status: 'work', source: 'Ручное добавление', date: 'Вчера' },
  { name: 'Елена Примерова', contact: '+7 (900) 000-00-02', request: 'Нужна консультация по запуску интернет-магазина.', tag: 'Сайт', status: 'new', source: 'Telegram-бот', date: '18 сен' },
  { name: 'Дмитрий Образцов', contact: 'demo@example.invalid', request: 'Ищу поддержку по фирменному стилю и макетам.', tag: 'Дизайн', status: 'wait', source: 'Ручное добавление', date: '17 сен' },
  { name: 'Ольга Макетова', contact: '+7 (900) 000-00-05', request: 'Нужен одностраничный сайт для тестового проекта.', tag: 'Новый', status: 'new', source: 'Telegram-бот', date: '16 сен' },
];
const STATUS = { new: 'Новый', work: 'В работе', wait: 'Ожидает' };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const state = { filter: 'all', query: '' };
function render() {
  const visible = DEMO_LEADS.filter(lead => {
    const filterMatch = state.filter === 'all' || (state.filter === 'new' ? lead.status === 'new' : lead.source.startsWith(state.filter));
    const query = state.query.toLocaleLowerCase('ru');
    const textMatch = !query || `${lead.name} ${lead.contact} ${lead.request} ${lead.tag} ${lead.source}`.toLocaleLowerCase('ru').includes(query);
    return filterMatch && textMatch;
  });
  document.querySelector('#rows').innerHTML = visible.map(lead => `<tr><td><div class="name">${escapeHtml(lead.name)}</div><div class="contact">${escapeHtml(lead.contact)}</div></td><td class="request">${escapeHtml(lead.request)}</td><td><span class="tag ${lead.tag === 'Горячий' ? 'hot' : lead.tag === 'Новый' ? 'new' : ''}">${escapeHtml(lead.tag)}</span><div class="source">${STATUS[lead.status]}</div></td><td class="source">${escapeHtml(lead.source)}</td><td class="date">${escapeHtml(lead.date)}</td></tr>`).join('');
  document.querySelector('#empty').hidden = visible.length > 0;
  document.querySelector('#shown').textContent = `${visible.length} ${visible.length === 1 ? 'запись' : 'записей'}`;
}
document.querySelector('#total').textContent = DEMO_LEADS.length;
document.querySelector('#new').textContent = DEMO_LEADS.filter(lead => lead.status === 'new').length;
document.querySelector('#work').textContent = DEMO_LEADS.filter(lead => lead.status === 'work').length;
document.querySelector('#telegram').textContent = DEMO_LEADS.filter(lead => lead.source.startsWith('Telegram')).length;
document.querySelector('#search').addEventListener('input', event => { state.query = event.target.value.trim(); render(); });
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('active', item === button));
  state.filter = button.dataset.filter;
  render();
}));
render();
