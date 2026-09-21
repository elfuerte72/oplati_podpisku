import { createHash } from 'node:crypto';

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
 * Теперь — пул НАСТОЯЩИХ адресов. Правила пула держит тест
 * `billing-address.test.ts`, а существование адресов проверяет скрипт
 * `scripts/verify-billing-addresses.ts` (перепись США + OpenStreetMap):
 *
 *  - Только общественные здания (библиотеки). Чужой ЖИЛОЙ адрес в пул не
 *    кладём: он осел бы в десятках платёжных записей у сервисов, и это
 *    проблемы постороннего человека, а не наши.
 *  - Только штаты БЕЗ налога с продаж. Карта выпускается на цену сервиса плюс
 *    буфер под FX и VAT; налог штата (до ~10%) сервис добавил бы к цене сверху,
 *    и он съедал бы буфер, рассчитанный на другое.
 *  - Сети в пути выпуска карты больше нет: выбор адреса не может ни зависнуть,
 *    ни упасть — а вызывается он уже после приёма рублей.
 */

export type BillingAddress = {
  streetLine1: string;
  city: string;
  state: string;
  stateCode: string;
  postalCode: string;
  country: 'United States';
  countryCode: 'US';
};

const US = { country: 'United States', countryCode: 'US' } as const;

/**
 * Каждый адрес подтверждён 2026-09-21 ДВУМЯ источниками: геокодер Бюро
 * переписи США (номер дома в диапазоне улицы, канонический ZIP) и
 * OpenStreetMap (по адресу стоит названное здание). Новый адрес — только после
 * того же прогона: из восьми кандидатов «по памяти» двое проверку не прошли
 * (у одного оказался другой ZIP, второй перепись не нашла вовсе).
 *
 * ⚠️ Порядок не менять и из середины не удалять: адрес клиента выбирается по
 * номеру в пуле, и сдвиг поменял бы адрес уже обслуженным клиентам — у сервиса
 * их карта привязана со старым. Новые адреса дописывать В КОНЕЦ (часть
 * клиентов всё равно переедет — это цена отсутствия хранения, см. BACKLOG).
 */
export const BILLING_ADDRESS_POOL: readonly [BillingAddress, ...BillingAddress[]] = [
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

/**
 * Адрес клиента — ДЕТЕРМИНИРОВАННО от его id, а не случайно.
 *
 * Адрес нигде не хранится (уходит одним сообщением при выпуске карты), и при
 * случайном выборе повторный выпуск давал бы клиенту ДРУГОЙ адрес — при том
 * что у сервиса его аккаунт уже привязан к прежнему. Детерминизм даёт то же,
 * что дало бы хранение: один клиент — один адрес, и поддержка может назвать
 * его заново, когда клиент потерял сообщение.
 */
export function billingAddressForUser(userId: string): BillingAddress {
  // sha256, а не сумма кодов символов: uuid'ы клиентов отличаются хвостом, и
  // слабая свёртка складывала бы их в два-три адреса из пула.
  const digest = createHash('sha256').update(userId).digest();
  const index = digest.readUInt32BE(0) % BILLING_ADDRESS_POOL.length;
  return BILLING_ADDRESS_POOL[index] ?? BILLING_ADDRESS_POOL[0];
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
