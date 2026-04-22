# Deployment

## Платформа

**Vercel.** Регион — `fra1` (Frankfurt). Fluid Compute включён автоматически.

## Подключение проекта

1. Создать проект на Vercel: Dashboard → Add New → Project → Import Git Repository
2. **Root Directory**: оставить пустой (монорепа на верхнем уровне)
3. **Framework Preset**: Next.js
4. **Build Command**: `turbo build --filter=web`
5. **Install Command**: `pnpm install --frozen-lockfile`
6. **Output Directory**: `apps/web/.next`
7. **Node.js Version**: 24.x

## Environment Variables

Раздельно для **Production**, **Preview**, **Development**:

### Production
- Production Supabase project (EU)
- Production Anthropic API key
- Production YooKassa / CryptoBot (боевые магазины)
- Production Sentry project + environment=production
- `APP_URL=https://oplati.example.com`

### Preview
- **Отдельный** Supabase project (или branch через Supabase branching) для безопасности
- **Test** magazines YooKassa / CryptoBot
- Тот же Anthropic key или отдельный с лимитом расходов
- Sentry environment=preview
- `APP_URL=https://preview-<branch>.oplati.example.com`

### Development (локально)
- `.env.local` в `apps/web/`, не коммитить
- Локальный Supabase dev project
- `APP_URL=https://<tunnel>.ngrok.io`

## Регионы и функции

В `vercel.json` или через `apps/web/app/api/*/route.ts`:

```typescript
export const runtime = 'nodejs';  // Fluid Compute
export const preferredRegion = 'fra1';
export const maxDuration = 30;    // Telegram webhook 30s max
```

## Домен

1. Купить домен (например `oplati-podpisok.ru` или `.com`)
2. Vercel → Settings → Domains → Add
3. DNS: `A` на `76.76.21.21` и `CNAME` на `cname.vercel-dns.com` (подскажет Vercel UI)
4. Подождать propagation (до 48 часов, обычно минуты)
5. SSL — автоматически Let's Encrypt

### Subdomain strategy
- `oplati.example.com` — основной (лендинг, веб-чат, админка)
- `admin.oplati.example.com` — опционально выделить админку (Sprint 3)
- `api.oplati.example.com` — опционально для webhook'ов (избегает CORS проблем)

## Rolling releases (опционально)

Для критичных изменений — Rolling Releases (GA с июня 2025):
1. Deploy на Production создаёт candidate
2. Canary % — начать с 10% трафика
3. Ручной promote при отсутствии алертов в Sentry
4. 100% или rollback

## Post-deploy hooks

После каждого production deploy:
1. Webhook на Trigger.dev для деплоя задач (`trigger.dev deploy`)
2. Smoke test: `curl https://oplati.example.com/api/health` — ожидается `200 OK`
3. Sentry release создаётся автоматически через `@sentry/nextjs` webpack plugin

## Telegram webhook — продакшн

После первого успешного deploy на prod-домен:

```bash
curl -F "url=https://oplati.example.com/api/bot" \
     -F "secret_token={{TELEGRAM_WEBHOOK_SECRET}}" \
     -F "drop_pending_updates=true" \
     https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}/setWebhook
```

**Важно:** нельзя иметь два активных webhook на одном токене. При переключении между prod и dev — использовать разных ботов.

## Payment webhooks — настройка в провайдерах

### YooKassa
Кабинет → Интеграция → HTTP-уведомления:
- URL: `https://oplati.example.com/api/payments/yookassa`
- События: `payment.succeeded`, `payment.canceled`, `refund.succeeded`

### CryptoBot
@CryptoBot → My Apps → Edit → Webhooks:
- URL: `https://oplati.example.com/api/payments/cryptobot`

## Rollback

1. Vercel Dashboard → Deployments → prev. production → **Promote to Production**
2. Время — секунды
3. **Важно**: миграции БД — forward-only. При rollback кода новая схема БД остаётся. Поэтому:
   - Миграции должны быть **backwards-compatible** (добавлять колонки nullable, не удалять)
   - Перед destructive миграцией — backup + план отката

## CI/CD (GitHub Actions)

`.github/workflows/ci.yml`:
- On PR: `pnpm install` → `pnpm typecheck` → `pnpm lint` → `pnpm test`
- On merge to `main`: Vercel автоматически деплоит через GitHub integration

## Runbook: первый production deploy

1. [ ] Создать Supabase prod project, применить миграции
2. [ ] Seed каталог сервисов
3. [ ] Создать Supabase Storage buckets + политики
4. [ ] Invite staff аккаунты в Supabase Auth
5. [ ] Создать production бота @BotFather, получить токен
6. [ ] Настроить YooKassa production shop + получить ключи
7. [ ] Настроить CryptoBot production app + ключи
8. [ ] Получить production Anthropic API key (с лимитом)
9. [ ] Заполнить все env в Vercel (Production)
10. [ ] Первый deploy (`vercel --prod`)
11. [ ] Зарегистрировать Telegram webhook на prod URL
12. [ ] Зарегистрировать payment webhooks
13. [ ] Создать TG-группу операторов + добавить бота админом
14. [ ] Получить `TELEGRAM_OPERATORS_GROUP_ID`, обновить env, redeploy
15. [ ] Smoke test: написать боту, сделать тестовый заказ с минимальной суммой
16. [ ] Deploy Trigger.dev tasks (`trigger.dev deploy --env prod`)
17. [ ] Выключить Preview deployments для main branch (остаётся только Production)
18. [ ] Включить Sentry alerts
19. [ ] Провести runbook с операторами
