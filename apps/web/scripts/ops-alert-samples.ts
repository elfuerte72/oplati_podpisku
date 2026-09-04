/**
 * Образцы уведомлений ops-группы — как они выглядят в Telegram.
 *
 * Тексты скопированы из точек вызова `notifyOps`/`notifyStaff` с правдоподобными
 * значениями и собраны тем же `formatOpsMessage`, что на проде. Запуск:
 *
 *   pnpm --filter web exec tsx scripts/ops-alert-samples.ts            # напечатать
 *   OPS_SEND=1 TELEGRAM_LOGIN_BOT_TOKEN=… OPS_GROUP_CHAT_ID=… \
 *     OPS_GROUP_THREAD_CRITICAL=3 … pnpm --filter web exec tsx scripts/ops-alert-samples.ts   # отправить в темы
 *
 * Отправка — прямым вызовом Bot API, без приложения: это смоук формы сообщения,
 * а не пути доставки (он проверяется тестами и живым обращением).
 */
import { formatOpsMessage, type OpsMessage } from '../lib/alerts/format';
import type { AlertStream } from '../lib/alerts/kinds';

type Sample = OpsMessage & { stream: AlertStream; label: string };

const PANEL_HOST = process.env.PANEL_HOST ?? 'admin.oplatishka.com';

const samples: Sample[] = [
  {
    label: 'issue-card: markOrderFailed',
    stream: 'critical',
    title: 'Оплаченный заказ не доставлен',
    facts: [
      { label: 'Заказ', value: 'ORD-7F3K2' },
      { label: 'Причина', value: 'paypace_error' },
    ],
    body: 'Деньги приняты, выпуск карты упал. Нужен ручной разбор.',
    action: { text: 'разобрать и выдать вручную', path: '/admin/orders/ORD-7F3K2' },
  },
  {
    label: 'issue-card: topup pending',
    stream: 'critical',
    title: 'Топап с неизвестным исходом',
    facts: [
      { label: 'Заказ', value: 'ORD-7F3K2' },
      { label: 'requestId', value: 't_9a1f3c2e7b4d5a60' },
      { label: 'cardId', value: 'c_48213' },
    ],
    body:
      'Топап PaySpace завис в pending — исход неизвестен, деньги могли зачислиться позже. ' +
      'Повтор топапа идемпотентен по request_id.',
    action: { text: 'проверить операцию в кабинете PaySpace, затем выдать вручную', path: '/admin/orders/ORD-7F3K2' },
  },
  {
    label: 'preflight: blocked',
    stream: 'critical',
    title: 'Клиент не смог оплатить: не хватает карточного фонда',
    facts: [
      { label: 'Заказ', value: 'ORD-9Q2LM (11 680 ₽)' },
      { label: 'Нужно на заказ', value: '124.00 USD' },
      { label: 'Не хватает', value: '34.50 USD' },
    ],
    body:
      'Свободно 89.50 USD (124.00 USD на счёте уже обещаны картам по заказам с живым счётом, ' +
      'оплаченным и в выпуске). Счёт клиенту не выставлен, заказ жив с зафиксированной ценой.',
    action: { text: 'пополнить карточный счёт PaySpace (зачисление T+1)', path: '/admin' },
  },
  {
    label: 'payment-conversion',
    stream: 'critical',
    title: 'За час ни одной оплаты',
    body: 'Похоже, оплаты не проходят: за последний час выставлено 7 счетов через freekassa, оплачено 0.',
    action: { text: 'проверить шлюз; при необходимости переключить PAYMENT_PRIMARY_PROVIDER на резервный и сделать redeploy' },
  },
  {
    label: 'freekassa: underpayment',
    stream: 'payments',
    title: 'Недоплата (Freekassa)',
    facts: [
      { label: 'Выставлено', value: '3250.00 ₽' },
      { label: 'Оплачено', value: '3000.00 ₽' },
      { label: 'Операция', value: '418223311' },
    ],
    body: 'Заказ переведён в failed, карта НЕ выпущена — нужен ручной возврат клиенту.',
    action: { text: 'вернуть деньги клиенту вручную', path: '/admin/orders?s=failed' },
  },
  {
    label: 'poll-payment: hold',
    stream: 'payments',
    title: 'Платёж на проверке банка',
    facts: [
      { label: 'Операция', value: '418223311' },
      { label: 'Сумма', value: '3250.00 ₽' },
    ],
    body:
      'Антифрод Freekassa (статус 7). Деньги списаны, карта не выпущена — исход решает провайдер. ' +
      'Обычно разрешается за часы.',
    action: { text: 'ждать исхода; дольше суток — написать в поддержку Freekassa', path: '/admin/holds' },
  },
  {
    label: 'vcc-balance: warning',
    stream: 'payments',
    title: 'Карточный счёт ниже нормы',
    facts: [
      { label: 'Остаток', value: '312.40 USD' },
      { label: 'Нужно на самый дорогой', value: '1452.00 USD' },
    ],
    body: 'На типовой заказ хватает, на самый дорогой — нет. Пополнение приходит T+1.',
    action: { text: 'пополнить карточный счёт PaySpace (зачисление T+1)', path: '/admin' },
  },
  {
    label: 'support: new request (буквально как из бота, после stripHtmlTags)',
    stream: 'support',
    body:
      '🆘 Новое обращение в поддержку\n\n' +
      'Пользователь: Иван Петров\nUsername: @ivan_p\nTelegram ID: 123456789\n' +
      'Профиль: открыть чат (tg://user?id=123456789)\n\n' +
      'Сообщение:\nОплатил Netflix вчера, карта пришла, но на сайте пишет «карта отклонена». Что делать?',
    preformatted: true,
    action: { text: 'ответить клиенту', path: '/admin/support' },
  },
  {
    label: 'support-housekeeping: unanswered',
    stream: 'support',
    title: 'Обращение без ответа',
    facts: [{ label: 'Ждёт', value: '3 ч' }],
    body: 'Обращение без ответа 3 ч. Клиент ждёт в поддержке — ответить можно из панели, раздел «Поддержка».',
    action: { text: 'ответить клиенту', path: '/admin/support' },
  },
  {
    label: 'funnel: low rating',
    stream: 'support',
    title: 'Низкая оценка заказа',
    facts: [
      { label: 'Оценка', value: '2/5' },
      { label: 'Заказ', value: 'ORD-7F3K2' },
    ],
    body: 'Клиент поставил 2/5 заказу ORD-7F3K2 — нужен взгляд человека. Если напишет в поддержку — обращение придёт как обычно.',
    action: { text: 'посмотреть заказ и при необходимости связаться с клиентом', path: '/admin/orders/ORD-7F3K2' },
  },
  {
    label: 'sentry relay (свой формат, без шаблона)',
    stream: 'errors',
    preformatted: true,
    body:
      'Sentry · error\nFreekassaApiError: Request with same (or bigger) nonce already exist\n\n' +
      'Где: GET /api/cron/poll-payment\nОкружение: production\n\nhttps://oplatishka.sentry.io/issues/1117540176/',
  },
];

function render(s: Sample): string {
  const { label: _label, ...message } = s;
  return formatOpsMessage(message, PANEL_HOST);
}

async function main(): Promise<void> {
  const send = process.env.OPS_SEND === '1';
  const token = process.env.TELEGRAM_LOGIN_BOT_TOKEN;
  const chatId = process.env.OPS_GROUP_CHAT_ID;
  for (const s of samples) {
    const text = render(s);
    process.stdout.write(`\n════ [${s.stream}] ${s.label}\n${text}\n`);
    if (!send) continue;
    if (!token || !chatId) throw new Error('OPS_SEND=1 требует TELEGRAM_LOGIN_BOT_TOKEN и OPS_GROUP_CHAT_ID');
    const thread = process.env[`OPS_GROUP_THREAD_${s.stream.toUpperCase()}`];
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(thread ? { message_thread_id: Number(thread) } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    process.stdout.write(`→ sent: HTTP ${res.status}\n`);
    if (!res.ok) process.stdout.write(`${await res.text()}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
