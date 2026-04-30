# 2026-04-30 — Preview-деплой Vercel fra1 — merged

PR [#7](https://github.com/elfuerte72/oplati_podpisku/pull/7) `feature/preview-deploy-vercel` → `main` принят и слит. Production-деплой собирается автоматически на новый коммит в `main`; `@test_prodipsa_bot` начинает писать диалоги в Supabase сразу после Ready.

## Состояние после merge

- Milestone «Preview-деплой (Vercel fra1)» закрыт в `.ai-factory/ROADMAP.md` (дата 2026-04-30).
- Webhook у `@dev_test_podpiska_bot` снят (`deleteWebhook`) — preview-deployment'ы временные, чтобы не оставлять «слепой» бот, копящий 404-ошибки.
- Production-webhook у `@test_prodipsa_bot` уже стоит на `https://oplati-podpisku-web.vercel.app/api/bot` (с предыдущего milestone'а) — Vercel при автодеплое **не дёргает** Telegram, поэтому отдельных действий не требуется.

## Скомпрометированные секреты, требующие ротации

В ходе сессии в чат попали:

- Dev-токен `@dev_test_podpiska_bot` (`8504069050:AAF...`).
- Webhook-secret для preview-окружения (`a16e4ff8...`).

Оба значения нужно считать публичными. Действие: `/revoke` у `@BotFather` для dev-бота + `openssl rand -hex 32` для нового webhook-secret и обновление `TELEGRAM_WEBHOOK_SECRET` в Vercel Preview env (Sensitive). Старые значения после ротации становятся бесполезны для атакующего.

Production-токены (`@test_prodipsa_bot`) и production-секрет в чат не попадали — ротация прода НЕ требуется.

## Lessons learned (свод)

1. **Vercel `Sensitive` env запись-only:** `vercel env pull` отдаёт `""`, это by design — нельзя использовать pull для аудита. Полагаемся на UI «Updated just now» + ручной rebuild для подхвата.
2. **Vercel env применяется только к новым deployments.** Смена `TELEGRAM_WEBHOOK_SECRET` без redeploy = старый preview отвечает 401.
3. **Redeploy через Dashboard может выбрать deployment не из feature-ветки.** Перед smoke'ом `vercel inspect <url>` → `Aliases` должен быть `git-<branch>`, не `git-main`.
4. **Telegram `404 Not Found` на `/bot/setWebhook`** = пустой токен в URL (`/bot/setWebhook`), а не «бот не существует».
5. **`vercel logs <url>` без `--follow` стримит только новые логи.** История недоступна через CLI v50; нужен Dashboard или открытый стрим до запроса.
