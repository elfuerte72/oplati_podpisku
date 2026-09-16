import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Канарейка advisory-локов занятия промокода (трек promo-codes).
 *
 * ⚠️ Зачем читать ИСХОДНИК, а не проверять поведение. Интеграционные тесты идут
 * на PGlite — она работает на ОДНОМ соединении, и `Promise.all` транзакций там
 * сериализуется сам. Настоящей гонки не возникает, поэтому удаление ОБОИХ
 * `pg_advisory_xact_lock` оставляет весь `promo-codes.integration.test.ts`
 * зелёным (проверено мутацией на ревью 2026-09-11). То есть тесты, которые
 * выглядели защитой локов, ею не были.
 *
 * На живом Postgres цена пропажи лока — деньги: два параллельных заказа одного
 * клиента оба видят «применений ноль» и оба получают скидку по коду «один раз
 * на клиента»; два разных клиента так же пробивают общий лимит акции.
 *
 * Проверять поведением можно было бы только на настоящем Postgres с двумя
 * соединениями — этого в прогоне нет (известная слепая зона, см.
 * `docs/reference/testing.md`). Пока её нет, канарейка по исходнику — способ
 * сделать удаление лока ЗАМЕТНЫМ, а не молчаливым.
 *
 * Тот же приём уже применяется в проекте к вещам, которые не падают сами:
 * `panel-css.test.ts` (класс без описания), `labels.test.ts` (тон словаря),
 * `texts.test.ts` (константы мимо оверлея).
 */

const SOURCE = readFileSync(
  join(import.meta.dirname, 'repositories', 'promo-codes.ts'),
  'utf8',
);

/** Тело `reservePromoForOrder` — только оно и интересно. */
function reserveBody(): string {
  const start = SOURCE.indexOf('export async function reservePromoForOrder');
  expect(start).toBeGreaterThan(0);
  const end = SOURCE.indexOf('\nexport ', start + 1);
  return SOURCE.slice(start, end > 0 ? end : undefined);
}

describe('занятие промокода держит оба advisory-лока', () => {
  it('лок по КОДУ на месте — иначе два клиента пробьют общий лимит акции', () => {
    expect(reserveBody()).toContain("pg_advisory_xact_lock(hashtext(${`promo:${promoCodeId}`})");
  });

  it('лок по КЛИЕНТУ на месте — иначе два заказа пробьют «один раз на клиента»', () => {
    expect(reserveBody()).toContain('pg_advisory_xact_lock(hashtext(${userId})');
  });

  it('⚠️ порядок «код → клиент» — иначе дедлок с занятием баллов', () => {
    // Баллы и заявка на вывод берут только `hashtext(userId)`. Возьми промокод
    // локи в обратном порядке — две транзакции встали бы крест-накрест.
    const body = reserveBody();
    const promoLock = body.indexOf('promo:${promoCodeId}');
    const userLock = body.indexOf('pg_advisory_xact_lock(hashtext(${userId})');
    expect(promoLock).toBeGreaterThan(0);
    expect(userLock).toBeGreaterThan(0);
    expect(promoLock).toBeLessThan(userLock);
  });

  it('счётчики лимитов читаются ВНУТРИ транзакции с локами', () => {
    // Расчёт снаружи мог устареть: именно на этом числе держится «один раз на
    // клиента», и читать его до лока — то же, что не брать лок вовсе.
    const body = reserveBody();
    const lock = body.indexOf('pg_advisory_xact_lock');
    const count = body.indexOf('FROM promo_redemptions pr');
    expect(count).toBeGreaterThan(lock);
  });

  it('ключ лока клиента ТОТ ЖЕ, что у баллов и заявки на вывод', () => {
    // Общий ключ — не совпадение: промокод и баллы тратят маржу одного заказа,
    // а заявка на вывод — тот же баланс. Разойдутся ключи — пропадёт
    // сериализация между ними.
    const bonus = readFileSync(
      join(import.meta.dirname, 'repositories', 'referral-redemptions.ts'),
      'utf8',
    );
    expect(bonus).toContain('pg_advisory_xact_lock(hashtext(${userId})');
  });
});
