# План: оставшиеся задачи

> Платёжная фаза Love&Pay завершена E2E на **dev** (2026-06-09): оплата → webhook
> (подпись + контракт) → `paid` → уведомление пользователю в Telegram; идемпотентно,
> с подстраховкой poll-payment. Историю работ см. в git (`bc50033`…`cd29427`).
> Ниже — только то, что осталось.

**Ветка:** `dev`

---

## A. Вывести оплату Love&Pay на production

Сейчас работает только на dev/preview. На **prod L&P-ключей нет вообще** (там лишь
`CRON_SECRET` + `TELEGRAM_*`).

- [ ] В Vercel **Production** добавить: `LOVEANDPAY_API_KEY`, `LOVEANDPAY_SECRET_KEY`,
      `LOVEANDPAY_BASE_URL`, `LOVEANDPAY_WEBHOOK_SECRET`, `INTERNAL_API_TOKEN`
      (`RATE_FALLBACK_USDT_RUB`, `COMMISSION_PERCENT`, `LOVEANDPAY_MIN_AMOUNT_RUB` — дефолты в коде).
- [ ] Зарегистрировать **отдельный** webhook в кабинете L&P на prod-URL
      `https://oplati-podpisku-web.vercel.app/api/payments/loveandpay` (L&P поддерживает
      несколько вебхуков → свой секрет; dev-вебхук не трогаем).
- [ ] Redeploy production.
- [ ] Smoke: платёж через прод-бота `@test_prodipsa_bot` → заказ `paid` + уведомление.
- [ ] Проверить cron `poll-payment` (на prod он реально крутится): `GET /api/cron/poll-payment`
      с `Authorization: Bearer <CRON_SECRET>` → `{ok:true,...}`.

## B. Починить «все Preview» секрет L&P

- [ ] `LOVEANDPAY_SECRET_KEY` корректен только как override для ветки `dev`; общий «все Preview»
      держит битое значение (`INVALID_SIGNATURE` для прочих preview-веток). Поставить верный
      `sk_*` в общий Preview либо убрать общий, оставив branch-override на `dev`.

---

## C. Фаза 2 — выпуск виртуальных карт (PaySpace / app.pay.space)

> ⚠️ Это **НЕ** Love&Pay. Карты выпускает **app.pay.space**; Love&Pay — только приём RUB.
> Сейчас заказ замирает на `paid` (guard в `issue-card`), карта не выпускается.
> Заказчик сообщил, что PaySpace «сделали новые карты» → провизионинг готов, можно тестить.

**Целевой флоу (со слов заказчика, 2026-06-09):**
1. Клиент платит Оплатишке (RUB) → ✅ уже работает.
2. Оператор подсказывает, как завести личный кабинет в ИИ-сервисе. *(ручное)*
3. Из PaySpace вытягиваем реквизиты карты (PAN/срок/CVC) с нужной USD-суммой → отдаём клиенту.
4. Клиент оплачивает картой сервис → карта **уходит в заморозку (freeze)**.
5. Клиент возвращается (новый заказ) → карта **размораживается + пополняется** → снова к оплате.

**Что уже есть в коде (частично):**
- `cards` (Drizzle): статус `active/idle/recycled`, `balanceUsdCents`, `lastUsedAt`.
- `issue-card.ts`: createCard / topup / переиспользовать активную карту юзера, привязать к
  заказу, отправить реквизиты в TG, перевести `paid → in_fulfillment → completed`.
- PaySpace-клиент: `createCard`, `topupCard`, `getCard`.
- cron `recycle-cards`: `active → idle (90д)`, `idle → recycled (180д)`.

**Чего НЕ хватает под флоу заказчика (gaps):**
- [ ] **Нет статуса `frozen`** в `card_status` и нет методов freeze/unfreeze у PaySpace-клиента.
      Наша модель — `active/idle/recycled` (по времени), заказчику нужен
      freeze-после-оплаты + unfreeze+topup-при-возврате. Нужно: `frozen` в enum (миграция
      Drizzle), `freezeCard`/`unfreezeCard` в клиенте + логика переиспользования в issue-card.
- [ ] **Подтвердить реальный контракт PaySpace API** (createCard/getCard/topup + есть ли
      freeze/unfreeze?). Сейчас контракт «приблизительный» (`pay-space/client.ts`,
      `runbook-mvp.md`). По аналогии с L&P — снять контракт живым вызовом ДО доверия.
- [ ] **ОТКРЫТЫЙ ВОПРОС к заказчику:** что ТРИГГЕРИТ заморозку? Мы не видим оплату клиента
      на стороне ИИ-сервиса. Варианты: (а) PaySpace шлёт webhook о трате по карте → freeze;
      (б) freeze сразу после выдачи реквизитов, unfreeze при следующем заказе; (в) оператор
      вручную. Без ответа пункт «после оплаты → заморозка» не автоматизировать.
- [ ] Включить выпуск: задать `PAYSPACE_*` (+ `COMMISSION_PERCENT`) в env → issue-card
      перестанет пропускать по guard'у `skipped_no_paypace`.
- [ ] Написать спецификацию фазы в `docs/` (сейчас флоу карт нигде не описан — есть только
      код + «приблизительный контракт» в runbook). По правилу проекта docs — источник правды.

**Готово, когда:** оплаченный заказ → выпуск/пополнение карты → клиент получил реквизиты в TG;
после использования карта замораживается; при следующем заказе размораживается + пополняется.
