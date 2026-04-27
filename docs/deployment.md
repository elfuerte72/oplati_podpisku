# Deployment

## Платформа

**Vercel.** Регион — `fra1` (Frankfurt). Fluid Compute включён автоматически.

## Текущее состояние

| Окружение | URL | Telegram-бот | Деплой |
|---|---|---|---|
| **Production** | `https://oplati-podpisku-web.vercel.app` (default Vercel-домен; custom-домен — будущий milestone) | `@test_prodipsa_bot` | Auto на merge в `main` |
| **Preview** | `oplati-podpisku-web-git-<branch>-<team>.vercel.app` (branch alias на каждую feature-ветку) | `@dev_test_podpiska_bot` | Auto на push в любую не-`main` ветку |
| **Development** | `http://localhost:3000` | `@dev_test_podpiska_bot` (через временный туннель: serveo / cloudflared / ngrok) | `pnpm --filter web dev` |

**Vercel Deployment Protection: Disabled.** Иначе Telegram-сервера получают `401` от Vercel SSO ещё до нашего кода и webhook не работает на preview. Защита остаётся через secret-token в `/api/bot`, HMAC у платежных webhook'ов, Supabase Auth + RLS у `/admin`. См. Settings → Deployment Protection.

**Раздельные Telegram-боты обязательны:** webhook у одного бота один. Если prod и preview используют один токен, то каждый push в feature-ветку ломает prod webhook. Поэтому два бота:

- **prod-бот** `@test_prodipsa_bot` — обслуживает реальных пользователей на production-URL
- **dev-бот** `@dev_test_podpiska_bot` — для тестов на preview-URL и локальной разработки

`TELEGRAM_BOT_TOKEN` и `TELEGRAM_WEBHOOK_SECRET` в Vercel env разделены по окружениям (Production / Preview), остальные (Supabase, Anthropic, APP_URL) — общие.

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
curl -F "url=https://oplati-podpisku-web.vercel.app/api/bot" \
     -F "secret_token={{PROD_TELEGRAM_WEBHOOK_SECRET}}" \
     -F "drop_pending_updates=true" \
     -F 'allowed_updates=["message"]' \
     "https://api.telegram.org/bot{{PROD_TELEGRAM_BOT_TOKEN}}/setWebhook"
```

Делается один раз — после смены custom-домена (например, на `oplati.<custom>.com`) перерегистрируется ровно так же с новым URL.

**Важно:** нельзя иметь два активных webhook на одном токене. Поэтому prod и dev — **разные боты** (см. «Текущее состояние»).

## Telegram webhook — preview (dev-бот)

Preview-deployment живёт на branch-alias URL, который **меняется при создании каждой новой feature-ветки** (но стабилен в рамках одной ветки). Поэтому при работе с PR webhook dev-бота надо **перерегистрировать**:

1. Push в `feature/<name>` → Vercel автоматически собирает Preview, GitHub-бот Vercel постит URL в комментарий PR
2. Получить URL из PR (или через `gh pr checks` / `vercel ls`)
3. Перерегистрировать webhook dev-бота:
   ```bash
   export DEV_TOKEN='<dev-bot-token>'
   export DEV_SECRET='<dev-webhook-secret>'
   export PREVIEW_URL='<branch-alias-url-из-PR-комментария>'

   curl -F "url=${PREVIEW_URL}/api/bot" \
        -F "secret_token=${DEV_SECRET}" \
        -F "drop_pending_updates=true" \
        -F 'allowed_updates=["message"]' \
        "https://api.telegram.org/bot${DEV_TOKEN}/setWebhook"
   ```
4. Открыть `@dev_test_podpiska_bot` в Telegram, тестировать
5. Логи: Vercel Dashboard → Deployments → текущий preview → Logs → фильтр `/api/bot` (события `telegram.webhook.received`, `telegram.message.ai_reply` с `durationMs` / `totalTokens`)
6. После merge в main — prod автоматически обновляется. На следующий PR — `setWebhook` на новый URL (старый branch-alias через какое-то время архивируется Vercel'ом)

**Гигиена:** после закрытия PR без merge или удаления ветки — старый branch-alias умрёт, и Telegram начнёт получать 5xx на webhook. Не критично (бот для тестов), но при смене ветки лучше сразу `setWebhook` на новый URL или `deleteWebhook`, если паузишь разработку.

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
