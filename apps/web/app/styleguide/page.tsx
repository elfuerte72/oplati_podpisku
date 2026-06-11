import type { Metadata } from 'next';
import {
  ComicButton,
  OrderPanel,
  PaidStamp,
  QuickReplyChip,
  ServiceCard,
  SpeechBubble,
  TypingBubble,
} from '@/components/comic';

export const metadata: Metadata = {
  title: 'Оплатишка — styleguide',
  robots: { index: false, follow: false },
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <h2 className="font-display text-2xl font-bold text-[var(--text)]">
        {title}
      </h2>
      {children}
    </section>
  );
}

const CHIPS = ['Хочу Spotify', 'Сколько стоит Claude?', 'Оплатить Netflix', 'Midjourney на месяц'];

export default function StyleguidePage() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-12 px-6 py-12">
      <header className="space-y-2">
        <h1 className="font-display text-4xl font-bold text-[var(--text)]">
          Оплатишка · design system
        </h1>
        <p className="font-body text-[var(--text-muted)]">
          Комикс-компаньон: контуры, жёсткие тени, halftone, речь в облаках. Фаза 0.
        </p>
      </header>

      <Section title="Цвета">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['teal-primary', '#268B89'],
            ['teal-light', '#5B9C99'],
            ['teal-deep', '#306874'],
            ['ink', '#16151A'],
            ['paper', '#FBFCF7'],
            ['brown', '#6E4E4C'],
            ['glasses', '#2E3A8C'],
            ['stamp', '#C2362F'],
          ].map(([name, hex]) => (
            <div
              key={name}
              className="overflow-hidden rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] shadow-[var(--shadow-comic)]"
            >
              <div className="h-14" style={{ backgroundColor: hex }} />
              <div className="bg-[var(--surface)] px-3 py-2">
                <p className="font-body text-xs text-[var(--text)]">{name}</p>
                <p className="font-body text-xs text-[var(--text-muted)]">{hex}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Типографика">
        <p className="font-display text-3xl font-bold text-[var(--text)]">
          Заголовок display — ОПЛАТИШКА 1990 ₽
        </p>
        <p className="font-body text-base text-[var(--text)]">
          Body Rubik: привет! Я оплачу любую иностранную подписку — Claude,
          Netflix, Spotify, Midjourney. Просто напиши, что нужно.
        </p>
      </Section>

      <Section title="Облака диалога">
        <div className="halftone flex flex-col gap-3 rounded-[var(--radius-card)] bg-[var(--bg)] p-4">
          <SpeechBubble from="bot">
            Привет! Я Оплатишка. Что оплатим сегодня?
          </SpeechBubble>
          <SpeechBubble from="user">Хочу Spotify Premium на месяц</SpeechBubble>
          <SpeechBubble from="bot">Секунду, смотрю тарифы…</SpeechBubble>
          <TypingBubble />
        </div>
      </Section>

      <Section title="Quick-reply чипы">
        <div className="flex flex-wrap gap-2">
          {CHIPS.map((c) => (
            <QuickReplyChip key={c}>{c}</QuickReplyChip>
          ))}
        </div>
      </Section>

      <Section title="Кнопки">
        <div className="flex flex-wrap items-center gap-3">
          <ComicButton variant="primary">Подтвердить</ComicButton>
          <ComicButton variant="surface">Изменить</ComicButton>
          <ComicButton variant="primary" disabled>
            Недоступно
          </ComicButton>
        </div>
      </Section>

      <Section title="Карточки сервисов">
        <div className="flex flex-wrap gap-4">
          <ServiceCard
            name="Spotify"
            plan="Premium"
            period="1 мес"
            priceKopecks={39900}
            action={<ComicButton variant="primary">Выбрать</ComicButton>}
          />
          <ServiceCard
            name="Claude"
            plan="Pro"
            period="1 мес"
            priceKopecks={199000}
            action={<ComicButton variant="primary">Выбрать</ComicButton>}
          />
        </div>
      </Section>

      <Section title="Панель заказа + штамп">
        <div className="flex flex-wrap items-start gap-6">
          <OrderPanel
            service="Claude Pro · 1 мес"
            rows={[
              { label: 'Регион', value: 'US' },
              { label: 'Период', value: '1 месяц' },
            ]}
            amountKopecks={199000}
            confirm={<ComicButton variant="primary">Подтвердить</ComicButton>}
            secondary={<ComicButton variant="surface">Изменить</ComicButton>}
          />
          <OrderPanel
            service="Spotify Premium · 1 мес"
            rows={[{ label: 'Аккаунт', value: 'личный' }]}
            amountKopecks={39900}
            stamp={<PaidStamp />}
          />
        </div>
      </Section>

      <Section title="Светлая тема (бумажный комикс)">
        <div
          data-theme="light"
          className="halftone space-y-3 rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--bg)] p-5"
        >
          <SpeechBubble from="bot">Тот же стиль, светлая палитра.</SpeechBubble>
          <SpeechBubble from="user">Выглядит как бумажный комикс</SpeechBubble>
          <div className="flex gap-3">
            <ComicButton variant="primary">Подтвердить</ComicButton>
            <ComicButton variant="surface">Изменить</ComicButton>
          </div>
        </div>
      </Section>
    </main>
  );
}
