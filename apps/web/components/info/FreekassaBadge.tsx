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
 * `/_next/image?url=…`, и проверка, ищущая в HTML ссылку на их CDN, могла бы не
 * найти баннер. Разметка держится максимально близкой к провайдерской.
 *
 * ⚠️ ПУТЬ К КАРТИНКЕ ОТЛИЧАЕТСЯ ОТ ТОГО, ЧТО ОТДАЁТ ИХ ФОРМА. Сниппет из формы
 * регистрации указывает `cdn.freekassa.net/banners/medium_1.png` — этот путь
 * отдаёт **404** (проверено с двух IP, с `Referer` и браузерным UA, так что дело
 * не в hotlink-защите; корень CDN 403, соседние пути тоже 404 — похоже, файлы
 * переехали при ребрендинге в DUCKGO, а форма отдаёт старый URL). Рабочий путь —
 * `images/logos/banners/medium_1.png` (200, image/png, 180x70). НЕ «исправлять»
 * его назад на путь из сниппета: вернётся битая картинка.
 * Домен тот же, поэтому правка CSP не потребовалась.
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
      className={`inline-block opacity-70 transition-opacity hover:opacity-100 ${className}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- см. докстринг:
          next/image переписывает src, а провайдер проверяет свой литеральный URL. */}
      <img
        src="https://cdn.freekassa.net/images/logos/banners/medium_1.png"
        title="Прием платежей на сайте для физических лиц и т.д."
        alt="Freekassa — приём платежей"
        loading="lazy"
        decoding="async"
        width={180}
        height={70}
        className="h-auto w-[180px] max-w-full"
      />
    </a>
  );
}
