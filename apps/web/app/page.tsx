import { ChatClient } from '@/components/chat/ChatClient';
import { IntroOverlay } from '@/components/intro/IntroOverlay';

/**
 * Chat-first главная: full-screen shell (навбар · диалог с Оплатишкой · профиль).
 * Пока диалога нет — StartScreen: hero-приветствие + каталог с тарифами,
 * happy path «сервис → тариф → оплата» идёт без AI (/api/catalog +
 * /api/orders/propose). Telegram-бот по-прежнему шлёт GREETING на /start.
 * IntroOverlay — комикс-знакомство при первом визите (localStorage-флаг).
 */
export default function HomePage() {
  return (
    <>
      <h1 className="sr-only">
        Оплати подписки — оплата иностранных подписок (Claude, Netflix, Spotify,
        ChatGPT) рублями, СБП и криптой
      </h1>
      <ChatClient />
      <IntroOverlay />
    </>
  );
}
