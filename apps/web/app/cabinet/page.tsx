import type { Metadata } from 'next';
import { preload } from 'react-dom';

import { CabinetClient } from '@/components/cabinet/CabinetClient';
import { TELEGRAM_SDK_URL } from '@/components/cabinet/telegram-sdk-url';

/**
 * /cabinet — Telegram Mini App, личный кабинет клиента. Открывается из Menu
 * Button бота. Авторизация — по `initData` (см. lib/cabinet/auth.ts), отдельный
 * логин/cookie не нужны. Страница — обычный route в этом же Next.js-приложении.
 */
export const metadata: Metadata = {
  title: 'Кабинет · Оплатишка',
  robots: { index: false, follow: false },
};

export default function CabinetPage() {
  // SDK Telegram качается вместе со страницей, а не после гидратации: его
  // вставляет клиентский код (`loadTelegramWebApp`), и без подсказки загрузка
  // с telegram.org начиналась бы только после разбора всего JS кабинета.
  preload(TELEGRAM_SDK_URL, { as: 'script' });
  return (
    <div className="halftone min-h-full min-w-0 flex-1 overflow-x-hidden">
      <CabinetClient />
    </div>
  );
}
