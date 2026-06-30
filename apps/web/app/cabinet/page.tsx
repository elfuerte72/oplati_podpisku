import type { Metadata } from 'next';

import { CabinetClient } from '@/components/cabinet/CabinetClient';

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
  return (
    <div className="halftone min-h-full min-w-0 flex-1 overflow-x-hidden">
      <CabinetClient />
    </div>
  );
}
