/**
 * Заведение и обслуживание промокодов (трек promo-codes).
 *
 * Запуск (грузит `.env` из корня; для другой БД переопределить `DATABASE_URL`):
 *   pnpm --filter @oplati/db db:promo list
 *   pnpm --filter @oplati/db db:promo show <КОД>
 *   pnpm --filter @oplati/db db:promo add <КОД> <сумма_в_долларах> [опции]
 *   pnpm --filter @oplati/db db:promo disable <КОД>
 *   pnpm --filter @oplati/db db:promo enable <КОД>
 *
 * Опции `add`:
 *   --cap-to-margin       ограничить скидку маржой заказа (по умолчанию НЕТ —
 *                         номинал выдаётся целиком, как у ДАРЛИНГ)
 *   --min-order=<рубли>   порог суммы заказа, ниже которого код не действует
 *   --per-user=<N>        сколько раз код доступен одному клиенту (по умолч. 1)
 *   --max=<N>             общий лимит активаций (по умолчанию без лимита)
 *   --until=<YYYY-MM-DD>  последний день действия
 *   --from=<YYYY-MM-DD>   первый день действия
 *   --note=<текст>        заметка владельца (клиенту не показывается)
 *
 * Пример — первый код проекта:
 *   pnpm --filter @oplati/db db:promo add ДАРЛИНГ 5 --note="первый промокод"
 *
 * ⚠️ **Сумма задаётся в ДОЛЛАРАХ, и в БД лежит в центах** (`$5` → `500`). В рублях клиент
 * увидит её по курсу СВОЕГО заказа, поэтому величина плавает: при курсе 81 ₽ это ~405 ₽,
 * при 87.75 ₽ — 438 ₽. Число `500` в таблице — это пять долларов, а НЕ пятьсот рублей;
 * на этом уже спотыкались при чтении базы глазами. Рублёвого номинала («ровно 500 ₽»)
 * механика не поддерживает — он потребовал бы отдельной колонки.
 *
 * Почему скриптом, а не разделом панели: это редкая операция владельца, а
 * форма завела бы ещё один путь раздачи денег, который надо охранять. Раздел
 * панели — в `docs/BACKLOG.md`.
 *
 * ⚠️ Повторный `add` того же кода ОБНОВЛЯЕТ его правила, а не падает: заводя код
 * второй раз, владелец правит акцию. Уже выданные по нему скидки не меняются —
 * в `promo_redemptions` лежит СНИМОК номинала на момент применения.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import * as schema from '../src/schema.ts';
import { normalizePromoCode, PROMO_CODE_MAX_LENGTH } from '@oplati/types';
import {
  findPromoCodeByCode,
  listPromoCodes,
  setPromoCodeActive,
  summarizePromoCode,
  upsertPromoCode,
} from '../src/repositories/promo-codes.ts';

const USAGE = `Использование:
  manage-promo list
  manage-promo show <КОД>
  manage-promo add <КОД> <сумма_в_долларах> [--cap-to-margin] [--min-order=РУБЛИ]
                   [--per-user=N] [--max=N] [--from=YYYY-MM-DD] [--until=YYYY-MM-DD] [--note=ТЕКСТ]
  manage-promo disable <КОД>
  manage-promo enable <КОД>
`;

/**
 * Свой pino здесь был бы pino БЕЗ redact-листа приложения (см. manage-staff.ts):
 * ошибка драйвера `postgres` несёт строку подключения с паролем. Печатаем
 * только то, что сформировали сами.
 */
function fail(err: unknown): never {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`manage-promo failed: ${name}: ${message}\n`);
  process.exit(1);
}

/** `--ключ=значение` из хвоста аргументов. */
function flag(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(`--${name}`);
}

/** Целое положительное из флага; отсутствует — null, мусор — ошибка. */
function intFlag(args: readonly string[], name: string): number | null {
  const raw = flag(args, name);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} должен быть целым положительным числом, получено "${raw}"`);
  }
  return value;
}

/** Дата из флага. Полночь UTC — границы акции считаются по суткам. */
function dateFlag(args: readonly string[], name: string): Date | null {
  const raw = flag(args, name);
  if (raw === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`--${name} должен быть в формате YYYY-MM-DD, получено "${raw}"`);
  }
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`--${name}: несуществующая дата "${raw}"`);
  return date;
}

/** Доллары из аргумента в центы. Принимает и «5», и «4.99». */
function usdToCents(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`сумма должна быть положительным числом долларов, получено "${raw}"`);
  }
  const cents = Math.round(value * 100);
  if (cents <= 0) throw new Error('сумма меньше одного цента');
  return cents;
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatRub(kopecks: number): string {
  return `${(kopecks / 100).toFixed(0)} ₽`;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    process.stdout.write(USAGE);
    process.exit(1);
  }

  const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL_DIRECT or DATABASE_URL must be set (see .env in repo root)');
  }

  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 10 });
  const db = drizzle(sql, { schema });

  try {
    switch (command) {
      case 'list': {
        const rows = await listPromoCodes(db);
        if (rows.length === 0) {
          process.stdout.write('промокодов нет\n');
          break;
        }
        for (const c of rows) {
          // Счётчик считается ТЕМ ЖЕ правилом «живо», по которому код
          // перестаёт работать: число на экране владельца обязано совпадать
          // с тем, что видит гейт.
          const used = await summarizePromoCode(db, c.id);
          const limit = c.maxRedemptions === null ? '∞' : String(c.maxRedemptions);
          const parts = [
            c.code,
            formatUsd(c.discountUsdCents),
            c.isActive ? 'активен' : 'ВЫКЛЮЧЕН',
            c.capToMargin ? 'в пределах маржи' : 'номинал целиком',
            `${used.redemptions}/${limit} активаций`,
            `на клиента: ${c.perUserLimit}`,
            `выдано скидок: ${formatRub(used.discountKopecks)}`,
          ];
          if (c.minOrderAmountKopecks !== null) {
            parts.push(`от ${formatRub(c.minOrderAmountKopecks)}`);
          }
          if (c.startsAt) parts.push(`с ${c.startsAt.toISOString().slice(0, 10)}`);
          if (c.expiresAt) parts.push(`по ${c.expiresAt.toISOString().slice(0, 10)}`);
          if (c.note) parts.push(`— ${c.note}`);
          process.stdout.write(`${parts.join('\t')}\n`);
        }
        break;
      }

      case 'add': {
        const [rawCode, rawAmount] = args;
        if (!rawCode || !rawAmount) {
          process.stdout.write(USAGE);
          process.exit(1);
        }
        // ⚠️ Та же нормализация, что применяется к вводу клиента. Разъедутся —
        // заведённый код просто не найдётся, и отладить это можно будет только
        // hex-дампом (см. `normalizePromoCode`).
        const code = normalizePromoCode(rawCode);
        if (code.length === 0) throw new Error('код пустой после нормализации');
        if (code.length > PROMO_CODE_MAX_LENGTH) {
          throw new Error(`код длиннее ${PROMO_CODE_MAX_LENGTH} символов`);
        }
        if (code !== rawCode.trim().toUpperCase()) {
          // Код мог измениться (гомоглифы, разделители) — показываем, что
          // реально ляжет в базу, иначе владелец ищет «ДАРЛИНГ», а видит другое.
          process.stdout.write(`код нормализован: "${rawCode}" → "${code}"\n`);
        }

        const minOrderRub = intFlag(args, 'min-order');
        const row = await upsertPromoCode(db, {
          code,
          discountUsdCents: usdToCents(rawAmount),
          capToMargin: hasFlag(args, 'cap-to-margin'),
          minOrderAmountKopecks: minOrderRub === null ? null : minOrderRub * 100,
          perUserLimit: intFlag(args, 'per-user') ?? 1,
          maxRedemptions: intFlag(args, 'max'),
          startsAt: dateFlag(args, 'from'),
          expiresAt: dateFlag(args, 'until'),
          isActive: true,
          note: flag(args, 'note'),
        });

        process.stdout.write(
          `готово: ${row.code} даёт ${formatUsd(row.discountUsdCents)}, ` +
            `${row.capToMargin ? 'в пределах маржи заказа' : 'номинал целиком'}, ` +
            `${row.perUserLimit} раз(а) на клиента\n`,
        );
        // Номинал долларовый, и это стоит сказать вслух: в БД он лежит числом
        // 500, которое легко прочитать как «500 ₽».
        process.stdout.write(
          `номинал в ДОЛЛАРАХ (в базе — ${row.discountUsdCents} центов): ` +
            'клиент увидит скидку в рублях по курсу своего заказа, ' +
            'поэтому рублёвая величина плавает вместе с курсом\n',
        );
        if (!row.capToMargin) {
          // Про убыток на дешёвых заказах говорим вслух при КАЖДОМ заведении:
          // это решение владельца, но забыть о нём легко.
          process.stdout.write(
            'напоминание: номинал выдаётся целиком, поэтому на дешёвых заказах ' +
              'скидка может превысить нашу маржу — заказ уйдёт в минус\n',
          );
        }
        process.stdout.write(
          'код заработает, только когда на проде задан PROMO_CODES_ENABLED=1\n',
        );
        break;
      }

      case 'disable':
      case 'enable': {
        const [rawCode] = args;
        if (!rawCode) {
          process.stdout.write(USAGE);
          process.exit(1);
        }
        const code = normalizePromoCode(rawCode);
        const changed = await setPromoCodeActive(db, { code, isActive: command === 'enable' });
        if (!changed) {
          process.stdout.write(`нет такого кода: ${code}\n`);
          break;
        }
        process.stdout.write(
          `готово: ${code} ${command === 'enable' ? 'включён' : 'выключен'}\n` +
            (command === 'disable'
              ? 'уже занятые под живыми счетами скидки продолжают действовать — ' +
                'выключение не отменяет выставленные платёжные документы\n'
              : ''),
        );
        break;
      }

      case 'show': {
        const [rawCode] = args;
        if (!rawCode) {
          process.stdout.write(USAGE);
          process.exit(1);
        }
        const row = await findPromoCodeByCode(db, normalizePromoCode(rawCode));
        if (!row) {
          process.stdout.write('нет такого кода\n');
          break;
        }
        const used = await summarizePromoCode(db, row.id);
        process.stdout.write(
          `${row.code}: ${formatUsd(row.discountUsdCents)}, ${row.isActive ? 'активен' : 'выключен'}\n` +
            `активаций: ${used.redemptions}, выдано скидок: ${formatRub(used.discountKopecks)}\n`,
        );
        break;
      }

      default:
        process.stdout.write(USAGE);
        process.exit(1);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch(fail);
