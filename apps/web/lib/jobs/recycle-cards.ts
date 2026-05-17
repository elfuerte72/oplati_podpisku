import 'server-only';

import * as Sentry from '@sentry/nextjs';

import { getDb, recycleAgedCards } from '@oplati/db';

import { childLogger } from '../logger.ts';

const log = childLogger('cron.recycle-cards');

export async function recycleCards(): Promise<{ idled: number; recycled: number; errors: number }> {
  log.info({ event: 'cron.recycle_cards.start' });
  let errors = 0;
  let idled = 0;
  let recycled = 0;
  try {
    const result = await recycleAgedCards(getDb(), log);
    idled = result.idled;
    recycled = result.recycled;
  } catch (err) {
    errors++;
    log.error({ event: 'cron.recycle_cards.error', err });
    Sentry.captureException(err, { tags: { source: 'cron.recycle-cards' } });
  }
  log.info({ event: 'cron.recycle_cards.done', idled, recycled, errors });
  return { idled, recycled, errors };
}
