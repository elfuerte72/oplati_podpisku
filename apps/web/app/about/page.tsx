import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';

import { IconArrowRight, IconCheck, IconDoc, IconMail, IconSend } from '@/components/comic/icons';
import { InfoShell } from '@/components/info/InfoShell';
import {
  PRIVACY_UPDATED_AT,
  SUPPORT_EMAIL,
  SUPPORT_TELEGRAM,
  SUPPORT_TELEGRAM_URL,
  TERMS_UPDATED_AT,
} from '@/components/info/constants';

export const metadata: Metadata = {
  title: 'О сервисе · Оплатишка',
  description:
    'Что такое «Оплатишка»: оплата зарубежных подписок рублями, документы сервиса и контакты поддержки.',
};

/** Пункты «что мы делаем» — согласованы с УТП первого экрана (StartScreen). */
const ABOUT_CHECKS: readonly string[] = [
  'Оплата российской картой или через СБП',
  'Виртуальная карта для оплаты сервиса на вашем аккаунте',
  'Итоговая сумма видна до оплаты',
  'Помощь поддержки на каждом шаге',
];

/**
 * «О сервисе» — единая точка входа к публичным документам и контактам
 * поддержки (требование платёжного провайдера): описание сервиса, ссылки на
 * Пользовательское соглашение и Политику конфиденциальности с датами редакций,
 * контакты поддержки.
 */
export default function AboutPage() {
  return (
    <InfoShell title="О сервисе">
      {/* Кто мы: маскот + короткое описание. */}
      <section className="rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-5 shadow-[var(--shadow-comic)]">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:gap-6">
          <Image
            src="/mascot/support.webp"
            alt="Оплатишка — маскот сервиса в гарнитуре поддержки"
            width={450}
            height={1024}
            priority
            sizes="(min-width: 640px) 130px, 30vw"
            className="w-full max-w-[110px] shrink-0 sm:max-w-[130px] [filter:drop-shadow(4px_4px_0_rgba(11,10,13,0.35))]"
          />
          <div className="space-y-3 text-center font-body text-[15px] leading-relaxed text-[var(--text)] sm:text-left">
            <p>
              «Оплатишка» — сервис оплаты зарубежных подписок рублями. ChatGPT, Claude, Midjourney
              и другие сервисы — на ваш собственный аккаунт, без передачи пароля и покупки чужих
              аккаунтов.
            </p>
            <p>
              Вы выбираете сервис и тариф, видите итоговую сумму в рублях и оплачиваете картой или
              через СБП. Мы выпускаем виртуальную карту с нужной суммой — ею вы оплачиваете
              подписку на сайте сервиса.
            </p>
          </div>
        </div>
        <ul className="mt-5 space-y-2">
          {ABOUT_CHECKS.map((check) => (
            <li key={check} className="flex items-center gap-2.5 font-body text-sm text-[var(--text)]">
              <span
                aria-hidden
                className="grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] text-[var(--color-paper)]"
              >
                <IconCheck size={12} />
              </span>
              {check}
            </li>
          ))}
        </ul>
      </section>

      {/* Документы: ссылки с датами редакций — их проверяет платёжный провайдер. */}
      <section className="rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-5 shadow-[var(--shadow-comic)]">
        <h2 className="font-display text-lg font-bold text-[var(--text)]">Документы</h2>
        <div className="mt-3 space-y-2.5">
          {[
            { href: '/terms', title: 'Пользовательское соглашение', updatedAt: TERMS_UPDATED_AT },
            { href: '/privacy', title: 'Политика конфиденциальности', updatedAt: PRIVACY_UPDATED_AT },
          ].map((doc) => (
            <Link
              key={doc.href}
              href={doc.href}
              className="flex items-center gap-3 rounded-[12px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--bg)] px-4 py-3 shadow-[2px_2px_0_var(--shadow-ink)] transition-[transform,box-shadow] hover:-translate-y-0.5 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
            >
              <IconDoc size={20} className="shrink-0 text-[var(--accent)]" />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block font-display text-sm font-bold text-[var(--text)]">
                  {doc.title}
                </span>
                <span className="font-body text-xs text-[var(--text-muted)]">
                  Редакция от {doc.updatedAt}
                </span>
              </span>
              <IconArrowRight size={16} className="shrink-0 text-[var(--text-muted)]" />
            </Link>
          ))}
        </div>
      </section>

      {/* Поддержка: Telegram + почта. */}
      <section className="rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] p-5 shadow-[var(--shadow-comic)]">
        <h2 className="font-display text-lg font-bold text-[var(--text)]">Поддержка</h2>
        <p className="mt-2 font-body text-sm text-[var(--text-muted)]">
          Напишите нам — поможем с любым вопросом по оплате подписок.
        </p>
        <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
          <a
            href={SUPPORT_TELEGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex flex-1 items-center gap-3 rounded-[12px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] px-4 py-3 shadow-[var(--shadow-comic)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
          >
            <IconSend size={20} className="shrink-0 text-[var(--color-paper)]" />
            <span className="min-w-0 leading-tight">
              <span className="block font-display text-sm font-bold text-[var(--color-paper)]">
                Telegram
              </span>
              <span className="font-body text-xs text-[var(--color-paper)]/85">
                {SUPPORT_TELEGRAM}
              </span>
            </span>
          </a>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="flex flex-1 items-center gap-3 rounded-[12px] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--bg)] px-4 py-3 shadow-[var(--shadow-comic)] transition-[transform,box-shadow] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
          >
            <IconMail size={20} className="shrink-0 text-[var(--accent)]" />
            <span className="min-w-0 leading-tight">
              <span className="block font-display text-sm font-bold text-[var(--text)]">Почта</span>
              <span className="break-all font-body text-xs text-[var(--text-muted)]">
                {SUPPORT_EMAIL}
              </span>
            </span>
          </a>
        </div>
      </section>
    </InfoShell>
  );
}
