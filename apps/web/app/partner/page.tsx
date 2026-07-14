import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { PartnerCabinet } from '@/components/partner/PartnerCabinet';
import { getBotUsername } from '@/lib/telegram/bot';
import { telegramBotLink } from '@/lib/telegram/links';

/**
 * /partner — партнёрский кабинет на сайте Оплатишки (приоритетная поверхность
 * реферальной программы). Авторизация — по веб-сессии (`session`-cookie),
 * резолвится в `POST /api/cabinet/referral`. Тот же кабинет переиспользует
 * мини-апп (секция в /cabinet), передавая Telegram `initData`.
 *
 * Десктоп открывает кабинет прямо здесь; **мобильный браузер** уводим в Telegram
 * (там кабинет удобнее в мини-аппе) — по запросу владельца. Если имя бота не
 * резолвится — graceful: рендерим кабинет как есть.
 *
 * Программа за флагом `REFERRAL_ENABLED`: пока выключена — кабинет показывает
 * заглушку «скоро» (роут отдаёт спящий снапшот без записи в БД).
 */
export const metadata: Metadata = {
  title: 'Партнёрская программа · Оплатишка',
  description: 'Зарабатывай с каждой оплаты в твоей реферальной сети.',
  robots: { index: false, follow: false },
};

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i;

export default async function PartnerPage() {
  const ua = (await headers()).get('user-agent') ?? '';
  if (MOBILE_UA.test(ua)) {
    let bot: string | null = null;
    try {
      bot = await getBotUsername();
    } catch {
      bot = null;
    }
    if (bot) redirect(telegramBotLink(bot));
    // имя бота недоступно → не ломаем переход, рендерим кабинет
  }
  return <PartnerCabinet />;
}
