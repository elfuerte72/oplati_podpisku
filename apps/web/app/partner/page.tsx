import type { Metadata } from 'next';

import { PartnerCabinet } from '@/components/partner/PartnerCabinet';

/**
 * /partner — партнёрский кабинет на сайте Оплатишки (приоритетная поверхность
 * реферальной программы). Авторизация — по веб-сессии (`session`-cookie),
 * резолвится в `POST /api/cabinet/referral`. Тот же кабинет переиспользует
 * мини-апп (секция в /cabinet), передавая Telegram `initData`.
 *
 * Программа за флагом `REFERRAL_ENABLED`: пока выключена — кабинет показывает
 * заглушку «скоро» (роут отдаёт спящий снапшот без записи в БД).
 */
export const metadata: Metadata = {
  title: 'Партнёрская программа · Оплатишка',
  description: 'Зарабатывай с каждой оплаты в твоей реферальной сети.',
  robots: { index: false, follow: false },
};

export default function PartnerPage() {
  return <PartnerCabinet />;
}
