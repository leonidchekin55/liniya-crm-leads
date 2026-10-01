# Линия — CRM заявок агентства

CRM с общей базой лидов, паролем для менеджера, ручным добавлением, поиском, тегами, статусами и заявочным Telegram-ботом.

## Облачная версия

Вариант для бесплатного размещения подготовлен для Cloudflare Workers + D1: приложение работает на Worker, база лидов общая, статические файлы раздаются Cloudflare. См. [DEPLOY-FREE.md](DEPLOY-FREE.md). Потребуются Cloudflare аккаунт, ID созданной D1 базы и секреты `ADMIN_PASSWORD`, `SESSION_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`.

Бесплатный тариф имеет квоты: Workers — 100 000 запросов в сутки; у D1 также есть суточные лимиты чтения/записи. При достижении квот обращения к базе отклоняются до сброса. Это подходит для небольшой CRM, но не является гарантией бесперебойной работы. В аккаунте Cloudflare для production следует использовать собственные секреты и не коммитить их.

Команды после добавления database ID в `wrangler.toml`:

```sh
pnpm install
pnpm db:migrate:remote
pnpm wrangler secret put ADMIN_PASSWORD
pnpm wrangler secret put SESSION_SECRET
pnpm wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm wrangler secret put TELEGRAM_BOT_TOKEN
pnpm deploy
```

Если Telegram-бот ещё не создан, можно пока не задавать `TELEGRAM_BOT_TOKEN`; CRM и ручное добавление будут работать. Позже задайте токен, войдите в CRM и нажмите «Настроить Telegram».

## Render

Исходная PostgreSQL-версия находится рядом и может быть развёрнута через `render.yaml`, но она требует платной PostgreSQL базы. У Render бесплатный web service засыпает после простоя, а бесплатная база ограничена сроком хранения. Для бесплатного варианта используйте Cloudflare-конфигурацию.

## Сценарии MVP

- Бот по шагам собирает имя, контакт и запрос. До сбора он сообщает о передаче данных в CRM. После завершения лид с тегом «Новый» появляется в общей очереди.
- Менеджер вручную добавляет лид; теги создаются, назначаются и фильтруются.
- CRM закрыта паролем; публичная ссылка не открывает контакты и заявки без входа.
- Подключение личного аккаунта Telegram не входит в MVP.

## Локальный запуск Render-версии

Требуются Node.js 22+ и PostgreSQL. Настройте `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_PASSWORD` и `TELEGRAM_WEBHOOK_SECRET`, затем выполните `pnpm install --frozen-lockfile && pnpm start`. `TELEGRAM_BOT_TOKEN` можно не задавать для проверки CRM без бота.
