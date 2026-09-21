import { randomInt } from 'node:crypto';

import * as Sentry from '@sentry/nextjs';

import { getOrAssignUserBillingAddress, type DB } from '@oplati/db';
import type { BillingAddress } from '@oplati/types';

import { childLogger } from './logger.ts';

const log = childLogger('billing-address');

/**
 * Billing address, который клиент вводит на сайте сервиса вместе с картой.
 *
 * ⚠️ До 2026-09-21 адрес брался у `randomuser.me` — генератора фейковых персон.
 * Улицу, город, штат и ZIP он выдаёт НЕЗАВИСИМО друг от друга: «Indianapolis,
 * Washington 45410», «Corpus Christi, Ohio 97486». Живая проверка двадцати
 * адресов не нашла ни одного настоящего. Сайты сервисов сверяют ZIP со штатом
 * (расчёт налога с продаж, антифрод) и такой адрес отвергают — клиент получал
 * отказ оплаты при исправной карте, а с настоящим адресом та же карта
 * проходила (инцидент в `docs/incidents.md`).
 *
 * Теперь — пул НАСТОЯЩИХ адресов. Адрес выпадает клиенту СЛУЧАЙНО на первом
 * заказе и закрепляется за ним в `users.billing_address` (решение владельца
 * 2026-09-21): у сервиса аккаунт клиента привязан к выданному адресу, и на
 * следующем заказе он обязан получить тот же.
 *
 * Правила пула держит тест `billing-address.test.ts`, а существование адресов
 * проверяет скрипт `scripts/verify-billing-addresses.ts` (перепись США +
 * OpenStreetMap):
 *
 *  - Только штаты БЕЗ налога с продаж. Карта выпускается на цену сервиса плюс
 *    буфер под FX и VAT; налог штата (до ~10%) сервис добавил бы к цене сверху,
 *    и он съедал бы буфер, рассчитанный на другое.
 *  - Сети в пути выпуска карты нет: выбор адреса не может зависнуть на чужом
 *    сервисе — а вызывается он уже после приёма рублей.
 */

export type { BillingAddress };

const US = { country: 'United States', countryCode: 'US' } as const;

/**
 * Каждый адрес подтверждён 2026-09-21 ДВУМЯ источниками: геокодер Бюро
 * переписи США (номер дома в диапазоне улицы, канонический ZIP) и
 * OpenStreetMap (по адресу есть объект с этим номером дома). Новый адрес —
 * только после того же прогона: из восьми кандидатов «по памяти» двое проверку
 * не прошли (у одного оказался другой ZIP, второй перепись не нашла вовсе).
 *
 * Состав: два адреса владельца, с которыми он сам успешно платил, и шесть
 * общественных библиотек. ⚠️ Чужой ЖИЛОЙ адрес сюда не добавлять: он осел бы в
 * десятках платёжных записей у сервисов, и это проблемы постороннего человека.
 *
 * Пул можно менять свободно — клиенту хранится снимок адреса, а не номер в
 * пуле, и правка не трогает уже обслуженных.
 */
export const BILLING_ADDRESS_POOL: readonly [BillingAddress, ...BillingAddress[]] = [
  // Адреса владельца. ⚠️ У первого ZIP — 99503: владелец платил с 99508, и
  // проходило (сервисы сверяют ZIP со штатом, а не с домом), но настоящий ZIP
  // этого дома по переписи — 99503, и он пройдёт сверку любой строгости.
  { streetLine1: '201 W 36th Ave', city: 'Anchorage', state: 'Alaska', stateCode: 'AK', postalCode: '99503', ...US },
  { streetLine1: '1145 E 7th St', city: 'Wilmington', state: 'Delaware', stateCode: 'DE', postalCode: '19801', ...US },
  // Multnomah County Central Library
  { streetLine1: '801 SW 10th Ave', city: 'Portland', state: 'Oregon', stateCode: 'OR', postalCode: '97205', ...US },
  // Missoula Public Library
  { streetLine1: '455 E Main St', city: 'Missoula', state: 'Montana', stateCode: 'MT', postalCode: '59802', ...US },
  // Nashua Public Library
  { streetLine1: '2 Court St', city: 'Nashua', state: 'New Hampshire', stateCode: 'NH', postalCode: '03060', ...US },
  // Wilmington Public Library
  { streetLine1: '10 E 10th St', city: 'Wilmington', state: 'Delaware', stateCode: 'DE', postalCode: '19801', ...US },
  // Eugene Public Library
  { streetLine1: '100 W 10th Ave', city: 'Eugene', state: 'Oregon', stateCode: 'OR', postalCode: '97401', ...US },
  // Manchester City Library
  { streetLine1: '405 Pine St', city: 'Manchester', state: 'New Hampshire', stateCode: 'NH', postalCode: '03104', ...US },
];

/** Случайный адрес из пула. `randomInt` — без смещения, в отличие от `Math.random() * n`. */
export function pickRandomBillingAddress(): BillingAddress {
  const index = randomInt(BILLING_ADDRESS_POOL.length);
  return BILLING_ADDRESS_POOL[index] ?? BILLING_ADDRESS_POOL[0];
}

/**
 * Адрес клиента: закреплённый, а если его ещё нет — случайный из пула, который
 * этим же вызовом и закрепляется.
 *
 * ⚠️ Никогда не бросает. Вызывается в `issue-card` уже ПОСЛЕ приёма рублей, и
 * сбой вспомогательного шага не должен стоить клиенту карты. Не удалось
 * закрепить — клиент получает случайный адрес из того же пула: он настоящий и
 * оплату пройдёт, просто на следующем заказе может выпасть другой. Это шумит в
 * Sentry, а не молчит: незакреплённый адрес — ровно то, от чего мы уходили.
 */
export async function resolveBillingAddressForUser(db: DB, userId: string): Promise<BillingAddress> {
  const candidate = pickRandomBillingAddress();
  try {
    const assigned = await getOrAssignUserBillingAddress(db, { userId, candidate });
    if (assigned) return assigned;
    // Клиента нет либо в колонке лежит строка, не прошедшая схему.
    log.error({ event: 'billing_address.assign_unusable', userId });
    Sentry.captureMessage('billing_address: закреплённый адрес не читается', {
      level: 'error',
      tags: { source: 'billing-address' },
      extra: { userId },
    });
  } catch (err) {
    log.error({ event: 'billing_address.assign_failed', userId, err });
    Sentry.captureException(err, { tags: { source: 'billing-address' }, extra: { userId } });
  }
  return candidate;
}

export function formatBillingAddressLines(address: BillingAddress): string[] {
  return [
    `Street address: ${address.streetLine1}`,
    `City: ${address.city}`,
    `State: ${address.state} (${address.stateCode})`,
    `ZIP: ${address.postalCode}`,
    `Country: ${address.country}`,
  ];
}
