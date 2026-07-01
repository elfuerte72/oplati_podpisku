'use client';

import Image from 'next/image';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { ComicButton } from '@/components/comic';
import { mascotSrc } from '@/components/chat/Mascot';
import { TelegramLinkButton, useTelegramLink } from '@/components/chat/TelegramLink';

/**
 * Комикс-интро при первом визите: два «кадра» поверх чата.
 *
 * Кадр 1 — сплит: левая половина экрана — крупный Оплатишка в полный рост
 * (`/mascot/hero.png`, Higgsfield, «нарисовывается» через intro-draw-in),
 * правая — приветствие крупным текстом; клик в любом месте листает дальше.
 * Кадр 2 — сплит: слева сгенерированная комикс-панель с иконками сервисов
 * (`/intro/services.png`, Higgsfield от референсов content_site/logo), справа
 * «Как это работает» (3 шага) и кнопки: «Поехали» (закрыть) + необязательная
 * привязка Telegram (тот же флоу, что в гейте оплаты).
 * Показ — один раз, флаг в localStorage; «Пропустить» доступен всегда.
 */

const STORAGE_KEY = 'oplatishka_intro_seen';

const STEPS: { title: string; text: string }[] = [
  { title: 'Скажи, что оплатить', text: 'ChatGPT, Spotify, Netflix — или любой другой сервис, даже вне списка.' },
  { title: 'Я выставлю счёт в рублях', text: 'Найду актуальную цену и пришлю ссылку на оплату — СБП или карта.' },
  { title: 'Получи доступ', text: 'Чек и доступы по заказу придут сообщением в Telegram.' },
];

const noopSubscribe = () => () => {};

/**
 * «Видел ли пользователь интро» как external store (localStorage): на сервере
 * считаем «видел» (не рендерим — нет hydration mismatch), на клиенте читаем флаг.
 */
function useIntroSeen(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => {
      try {
        return window.localStorage.getItem(STORAGE_KEY) !== null;
      } catch {
        // приватный режим без localStorage — интро просто не показываем
        return true;
      }
    },
    () => true,
  );
}

export function IntroOverlay() {
  const introSeen = useIntroSeen();
  const [dismissed, setDismissed] = useState(false);

  const close = useCallback(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // не записалось — покажем интро ещё раз в следующий визит, не страшно
    }
    // Снимаем анти-FOUC-флаг (см. intro-init в layout + правило в globals.css):
    // shell был скрыт под оверлеем — теперь показываем его. Ставится флаг только
    // первому визиту, поэтому у вернувшихся снимать нечего.
    try {
      document.documentElement.removeAttribute('data-intro-pending');
    } catch {
      // атрибут не критичен — не роняем закрытие интро
    }
    setDismissed(true);
  }, []);

  if (introSeen || dismissed) return null;

  return <IntroFrames onClose={close} />;
}

/**
 * Сами кадры — отдельным компонентом, чтобы хук привязки (и его GET статуса)
 * жил только пока интро реально на экране.
 */
function IntroFrames({ onClose }: { onClose: () => void }) {
  const [frame, setFrame] = useState<1 | 2>(1);
  const { phase: linkPhase, start: startLink } = useTelegramLink({ checkOnMount: true });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Знакомство с Оплатишкой"
      className="halftone fixed inset-0 z-[60] flex flex-col overflow-y-auto bg-[var(--bg)]"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 z-10 rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--surface)] px-3 py-1.5 font-body text-sm text-[var(--text-muted)] shadow-[2px_2px_0_var(--shadow-ink)] transition-[transform,box-shadow] duration-150 [transition-timing-function:var(--ease-pop)] motion-safe:hover:scale-[1.08] active:translate-x-[2px] active:translate-y-[2px] active:scale-100 active:shadow-none"
      >
        Пропустить
      </button>

      {frame === 1 ? (
        /* ── Кадр 1: сплит — hero-Оплатишка слева, приветствие справа ── */
        <button
          type="button"
          onClick={() => setFrame(2)}
          aria-label="Дальше"
          className="grid min-h-[100dvh] w-full cursor-pointer grid-rows-[minmax(0,46dvh)_auto] lg:grid-cols-2 lg:grid-rows-1"
        >
          {/* Левая половина: маскот в полный рост, «нарисовывается» */}
          <span className="relative flex items-end justify-center overflow-hidden px-4 pt-10 lg:items-center lg:pt-0">
            <Image
              src="/mascot/hero.webp"
              alt="Оплатишка машет"
              width={1556}
              height={2004}
              priority
              sizes="(min-width: 1024px) 45vw, 80vw"
              className="h-full w-auto object-contain object-bottom [filter:drop-shadow(6px_6px_0_rgba(11,10,13,0.45))] motion-safe:animate-[intro-draw-in_800ms_var(--ease-pop)_both] lg:max-h-[88dvh] lg:object-center"
            />
          </span>

          {/* Правая половина: приветствие крупно */}
          <span className="flex flex-col items-center justify-center gap-6 px-6 pb-16 pt-8 text-center lg:items-start lg:px-14 lg:pb-0 lg:pt-0 lg:text-left">
            <span className="relative block max-w-xl rounded-[var(--radius-bubble)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--bubble-bot)] px-7 py-6 text-left shadow-[var(--shadow-comic-lg)] motion-safe:animate-[intro-rise_450ms_var(--ease-pop)_0.55s_both] lg:rounded-bl-[6px]">
              <span className="block font-display text-3xl font-bold leading-tight text-[var(--text)] lg:text-5xl">
                Привет! Я Оплатишка.
              </span>
              <span className="mt-3 block font-body text-base leading-snug text-[var(--text-muted)] lg:text-lg">
                Оплачиваю иностранные подписки рублями — любые. Ты пишешь, что нужно, я делаю
                остальное.
              </span>
              <span
                aria-hidden
                className="absolute -left-[9px] bottom-6 hidden h-3.5 w-3.5 rotate-45 border-b-[2.5px] border-l-[2.5px] border-[var(--shadow-ink)] bg-[var(--bubble-bot)] lg:block"
              />
            </span>

            <span className="inline-flex items-center gap-2 font-body text-sm text-[var(--text-muted)] motion-safe:animate-[intro-rise_400ms_var(--ease-pop)_1.1s_both]">
              <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />
              Тапни в любом месте — расскажу, как это работает
            </span>
          </span>
        </button>
      ) : (
        /* ── Кадр 2: сплит — панель с иконками сервисов слева, шаги справа ── */
        <div className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-8 px-6 py-14 lg:grid-cols-[5fr_6fr] lg:gap-14 lg:py-16">
          {/* Левая колонка: стикер-кластер сервисов (прозрачный фон, сливается с фоном страницы) */}
          <div
            className="relative mx-auto w-full max-w-xs sm:max-w-sm lg:max-w-none motion-safe:animate-[intro-rise_400ms_var(--ease-pop)_both]"
          >
            <Image
              src="/intro/services.webp"
              alt="Иконки сервисов: ChatGPT, Claude, Spotify, Netflix, YouTube, Airbnb"
              width={1200}
              height={1191}
              priority
              sizes="(min-width: 1024px) 40vw, 80vw"
              className="w-full [filter:drop-shadow(6px_6px_0_rgba(11,10,13,0.45))] lg:-rotate-2"
            />
            <span className="absolute -bottom-3 right-4 rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] px-4 py-1.5 font-display text-sm font-bold text-[var(--color-paper)] shadow-[2px_2px_0_var(--shadow-ink)] lg:rotate-2">
              …и любой другой
            </span>
          </div>

          {/* Правая колонка: как это работает + кнопки */}
          <div className="flex flex-col gap-5">
            <div className="flex items-end gap-4 motion-safe:animate-[intro-rise_350ms_var(--ease-pop)_both]">
              <Image
                src={mascotSrc('presenting')}
                alt="Оплатишка показывает"
                width={170}
                height={170}
                className="shrink-0 object-contain [filter:drop-shadow(4px_4px_0_rgba(11,10,13,0.45))]"
              />
              <h2 className="pb-3 font-display text-2xl font-bold leading-tight text-[var(--text)] lg:text-3xl">
                Как это работает
              </h2>
            </div>

            <ol className="space-y-3">
              {STEPS.map((step, i) => (
                <li
                  key={step.title}
                  className="flex items-start gap-4 rounded-[var(--radius-card)] border-[2.5px] border-[var(--shadow-ink)] bg-[var(--surface)] px-4 py-3 shadow-[var(--shadow-comic)] motion-safe:animate-[intro-rise_350ms_var(--ease-pop)_both]"
                  style={{ animationDelay: `${0.1 + i * 0.12}s` }}
                >
                  <span
                    aria-hidden
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 border-[var(--shadow-ink)] bg-[var(--color-teal-primary)] font-display text-lg font-bold text-[var(--color-paper)] shadow-[2px_2px_0_var(--shadow-ink)]"
                  >
                    {i + 1}
                  </span>
                  <span>
                    <span className="block font-display font-bold text-[var(--text)]">{step.title}</span>
                    <span className="block font-body text-sm text-[var(--text-muted)]">{step.text}</span>
                  </span>
                </li>
              ))}
            </ol>

            <div
              className="mt-1 flex flex-wrap items-center gap-3 motion-safe:animate-[intro-rise_350ms_var(--ease-pop)_both]"
              style={{ animationDelay: '0.5s' }}
            >
              <ComicButton onClick={onClose} className="px-7">
                Поехали!
              </ComicButton>
              {linkPhase !== 'linked' && (
                <TelegramLinkButton
                  phase={linkPhase}
                  onStart={() => void startLink()}
                  className="bg-[var(--surface)] text-[var(--text)]"
                />
              )}
              <p className="basis-full font-body text-xs text-[var(--text-muted)]">
                {linkPhase === 'linked'
                  ? 'Telegram уже привязан — туда придут чеки и доступы.'
                  : 'Привязка Telegram необязательна сейчас — попрошу её перед первой оплатой.'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
