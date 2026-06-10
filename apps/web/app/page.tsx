import { GREETING } from '@oplati/agent';

import { ChatClient } from '@/components/chat/ChatClient';

/**
 * Chat-first главная: full-screen shell (навбар · диалог с Оплатишкой · профиль).
 * GREETING берётся из @oplati/agent — единый голос с Telegram-ботом.
 */
export default function HomePage() {
  return (
    <>
      <h1 className="sr-only">
        Оплати подписки — оплата иностранных подписок (Claude, Netflix, Spotify,
        ChatGPT) рублями, СБП и криптой
      </h1>
      <ChatClient greeting={GREETING} />
    </>
  );
}
