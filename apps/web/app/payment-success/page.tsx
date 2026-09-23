import type { Metadata } from 'next';
import Link from 'next/link';

import { PaidStamp } from '@/components/comic';
import { childLogger } from '@/lib/logger';
import { getBotUsername } from '@/lib/telegram/bot';
import { cabinetDeepLink } from '@/lib/telegram/deep-links';

/**
 * Страница-приземление после оплаты в Love&Pay.
 *
 * L&P редиректит сюда по `successUrl` (см. apps/web/app/api/payments/create/route.ts
 * → buildTelegramDeepLink: `${APP_URL}/payment-success?order=<shortId>`).
 *
 * Важно: это НЕ источник статуса заказа — фактическая обработка идёт через
 * webhook L&P → issue-card, а реквизиты карты доставляются единственным путём —
 * сообщением в Telegram-бота. Страница лишь подтверждает приём оплаты и
 * направляет пользователя за реквизитами в бота.
 */

export const metadata: Metadata = {
  title: 'Оплата прошла — Оплатишка',
  // Технический thank-you-экран по платёжному редиректу — не индексируем.
  robots: { index: false, follow: false },
};

// shortId генерится как `ORD-<base32>` — пускаем только безопасный паттерн,
// чтобы не отрисовать произвольную строку из query.
const ORDER_RE = /^ORD-[A-Z0-9]{4,16}$/i;

type SearchParams = Promise<{ order?: string | string[] }>;

const log = childLogger('payment-success');

/**
 * Куда ведёт кнопка «Вернуться в Telegram». Клиент платит во внешнем браузере,
 * а карта и следующий шаг ждут его в Telegram — прежняя ссылка на корень сайта
 * уводила его в веб-чат, где AI выключен (разбор пути клиента 2026-09-23).
 * Best-effort, как `cabinetUrl` в `/api/profile`: без токена или при сбое
 * `getMe` кнопка ведёт на сайт — страница не падает.
 */
async function resolveReturnHref(): Promise<{ href: string; external: boolean }> {
  if (!process.env.TELEGRAM_BOT_TOKEN) return { href: '/', external: false };
  try {
    return { href: cabinetDeepLink(await getBotUsername()), external: true };
  } catch (err) {
    log.warn({ event: 'payment_success.bot_link_failed', err });
    return { href: '/', external: false };
  }
}

// Те же классы, что у ComicButton(variant primary) — здесь это ссылка (<a>),
// а не <button>, поэтому стиль продублирован осознанно (один экран, без state).
const CTA_CLASS = [
  'inline-flex items-center justify-center gap-2',
  'font-display font-bold',
  'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)]',
  'bg-[var(--color-teal-primary)] text-[var(--color-paper)]',
  'shadow-[var(--shadow-comic)] px-6 py-3',
  'transition-[transform,box-shadow] duration-150 [transition-timing-function:var(--ease-pop)]',
  'motion-safe:hover:scale-[1.07] motion-safe:hover:shadow-[var(--shadow-comic-lg)]',
  'active:translate-x-[3px] active:translate-y-[3px] active:scale-100 active:shadow-none',
].join(' ');

export default async function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { order } = await searchParams;
  const orderId =
    typeof order === 'string' && ORDER_RE.test(order) ? order.toUpperCase() : null;
  const back = await resolveReturnHref();

  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <section
        className={[
          'halftone relative w-full max-w-md',
          'rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)]',
          'bg-[var(--surface)] shadow-[var(--shadow-comic-lg)]',
          'px-7 py-9 text-center',
          'motion-safe:animate-[comic-pop_360ms_var(--ease-pop)_both]',
        ].join(' ')}
      >
        <div className="mb-6 flex justify-center">
          <PaidStamp label="Оплачено" />
        </div>

        <h1 className="font-display text-3xl font-bold text-[var(--text)]">
          Оплата прошла!
        </h1>

        {orderId ? (
          <p className="mt-3 text-sm text-[var(--text-muted)]">
            Заказ{' '}
            <span className="font-display font-bold text-[var(--accent)]">
              {orderId}
            </span>
          </p>
        ) : null}

        <p className="mt-5 text-[15px] leading-relaxed text-[var(--text)]">
          Через пару минут виртуальная карта появится <strong>в приложении
          Оплатишки</strong> и придёт в чат с ботом в Telegram. Последний шаг
          делаешь ты: оплатишь этой картой подписку на сайте сервиса, в своём
          аккаунте.
        </p>

        <p className="mt-3 text-sm text-[var(--text-muted)]">
          Реквизиты карты — в приложении и в чате с ботом, на этой странице их не будет.
        </p>

        <div className="mt-8 flex justify-center">
          {back.external ? (
            <a href={back.href} className={CTA_CLASS}>
              Вернуться в Telegram
            </a>
          ) : (
            <Link href={back.href} className={CTA_CLASS}>
              Вернуться к Оплатишке
            </Link>
          )}
        </div>
      </section>
    </main>
  );
}
