/**
 * Баннер Freekassa в футере сайта.
 *
 * Зачем: Freekassa подтверждает владение ресурсом, проверяя баннер **на главной
 * странице** заявленного URL (`oplatishka.com/`). Без него не пройти регистрацию
 * магазина, поэтому баннер обязан оставаться на месте, пока провайдер используется —
 * снятие может быть истолковано как нарушение условий.
 *
 * Почему только на сайте, а не в Mini App: краулер проверяет `/`, а не `/cabinet`.
 * Плюс в Telegram WebView обычная `<a target="_blank">` не открывается надёжно
 * (нужен `tg.openLink`), то есть в кабинете получилась бы битая ссылка — хуже,
 * чем её отсутствие.
 *
 * Почему обычный `<img>`, а не `next/image`: `next/image` переписал бы src в
 * `/_next/image?url=…`, и проверка, ищущая в HTML литерал
 * `cdn.freekassa.net/banners/medium_1.png`, могла бы не найти баннер. Разметка
 * оставлена ровно такой, какую отдаёт сам провайдер.
 *
 * ВАЖНО: домен `cdn.freekassa.net` добавлен в `img-src` CSP (`next.config.ts`).
 * Без этого при переводе CSP из Report-Only в enforce (задача в BACKLOG) картинка
 * молча перестала бы загружаться — для Freekassa это выглядит как снятый баннер.
 */
export function FreekassaBadge({ className = '' }: { className?: string }) {
  return (
    <a
      href="https://freekassa.net"
      target="_blank"
      rel="noopener noreferrer"
      title="Прием платежей"
      className={`inline-block opacity-70 transition-opacity hover:opacity-100 ${className}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- см. докстринг:
          next/image переписывает src, а провайдер проверяет свой литеральный URL. */}
      <img
        src="https://cdn.freekassa.net/banners/medium_1.png"
        title="Прием платежей"
        alt="Freekassa — приём платежей"
        loading="lazy"
        decoding="async"
        className="h-auto w-[180px] max-w-full"
      />
    </a>
  );
}
