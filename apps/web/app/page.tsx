import { GREETING } from '@oplati/agent';

import { ChatClient } from '@/components/chat/ChatClient';
import { IntroOverlay } from '@/components/intro/IntroOverlay';

/**
 * Chat-first главная: full-screen shell (навбар · диалог с Оплатишкой · профиль).
 * GREETING берётся из @oplati/agent — единый голос с Telegram-ботом.
 * IntroOverlay — комикс-знакомство при первом визите (localStorage-флаг).
 */
export default function HomePage() {
  return (
    <>
      <h1 className="sr-only">
        Оплати подписки — оплата иностранных подписок (Claude, Netflix, Spotify,
        ChatGPT) рублями, СБП и криптой
      </h1>
      <ChatClient greeting={GREETING} />
      <IntroOverlay />
    </>
  );
}
