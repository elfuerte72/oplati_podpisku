/**
 * Заведение и обслуживание персонала админ-панели.
 *
 * Запуск (грузит `.env` из корня; для другой БД переопределить `DATABASE_URL`):
 *   pnpm --filter @oplati/db db:staff list
 *   pnpm --filter @oplati/db db:staff add <telegram_id> <email> <роль> <имя...>
 *   pnpm --filter @oplati/db db:staff disable <telegram_id>
 *   pnpm --filter @oplati/db db:staff enable <telegram_id>
 *   pnpm --filter @oplati/db db:staff reset-totp <telegram_id>
 *
 * Почему скриптом, а не формой в панели: выдача доступа — редкая операция, а
 * форма завела бы ЕЩЁ ОДИН путь выдачи доступа, который надо охранять.
 *
 * ⚠️ Секрет TOTP здесь не выдаётся НАМЕРЕННО: его генерирует сама панель при
 * первом входе сотрудника и показывает ему один раз. `reset-totp` только
 * стирает привязку — потерявший телефон сотрудник привяжет приложение заново.
 * Так секрет не проходит через терминал, историю команд и чужие глаза.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import * as schema from '../src/schema.ts';
import {
  ASSIGNABLE_STAFF_ROLES,
  listStaff,
  resetStaffTotpByTelegramId,
  setStaffActiveByTelegramId,
  upsertStaffByTelegramId,
  type StaffRole,
} from '../src/repositories/staff.ts';

const USAGE = `Использование:
  manage-staff list
  manage-staff add <telegram_id> <email> <admin|operator> <имя...>
  manage-staff disable <telegram_id>
  manage-staff enable <telegram_id>
  manage-staff reset-totp <telegram_id>
`;

/** Нарушение конкретного UNIQUE-ограничения (код 23505 у postgres). */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(constraint) || message.includes('duplicate key');
}

/**
 * Свой pino здесь был бы pino БЕЗ redact-листа приложения (см. init-roles.ts):
 * ошибка драйвера `postgres` несёт строку подключения с паролем. Печатаем
 * только то, что сформировали сами.
 */
function fail(err: unknown): never {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`manage-staff failed: ${name}: ${message}\n`);
  process.exit(1);
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
        const rows = await listStaff(db);
        if (rows.length === 0) {
          process.stdout.write('персонал не заведён\n');
          break;
        }
        for (const s of rows) {
          const totp = s.totpConfirmedAt ? 'TOTP привязан' : 'TOTP не привязан';
          const active = s.isActive ? 'активен' : 'ОТКЛЮЧЁН';
          const seen = s.lastLoginAt ? s.lastLoginAt.toISOString() : 'ни разу';
          process.stdout.write(
            `${s.telegramId ?? '—'}\t${s.role}\t${active}\t${totp}\tвход: ${seen}\t${s.displayName} <${s.email}>\n`,
          );
        }
        break;
      }

      case 'add': {
        const [telegramId, email, role, ...nameParts] = args;
        const displayName = nameParts.join(' ').trim();
        if (!telegramId || !email || !role || !displayName) {
          process.stdout.write(USAGE);
          process.exit(1);
        }
        if (!/^\d+$/.test(telegramId)) {
          throw new Error('telegram_id — это число (узнать можно у @userinfobot)');
        }
        if (!(ASSIGNABLE_STAFF_ROLES as readonly string[]).includes(role)) {
          throw new Error(`роль должна быть одной из: ${ASSIGNABLE_STAFF_ROLES.join(', ')}`);
        }
        let staff;
        try {
          staff = await upsertStaffByTelegramId(db, {
            telegramId,
            email,
            displayName,
            role: role as StaffRole,
          });
        } catch (err) {
          // `email` тоже UNIQUE, а ON CONFLICT покрывает только `telegram_id`:
          // сырой 23505 наружу — это «duplicate key ...» вместо понятного
          // «этот email уже за другим сотрудником».
          if (isUniqueViolation(err, 'staff_email_unique')) {
            throw new Error(`email ${email} уже занят другим сотрудником`);
          }
          throw err;
        }
        process.stdout.write(
          `готово: ${staff.displayName} (${staff.role}), telegram ${staff.telegramId}\n` +
            'дальше сотрудник заходит на /admin/login, привязывает приложение с кодами\n' +
            'и ОБЯЗАТЕЛЬНО один раз запускает бота входа — иначе уведомления не дойдут\n',
        );
        break;
      }

      case 'disable':
      case 'enable': {
        const [telegramId] = args;
        if (!telegramId) {
          process.stdout.write(USAGE);
          process.exit(1);
        }
        const changed = await setStaffActiveByTelegramId(db, telegramId, command === 'enable');
        process.stdout.write(
          changed ? `готово: доступ ${command === 'enable' ? 'открыт' : 'закрыт'}\n` : 'нет такого сотрудника\n',
        );
        if (!changed) process.exit(1);
        break;
      }

      case 'reset-totp': {
        const [telegramId] = args;
        if (!telegramId) {
          process.stdout.write(USAGE);
          process.exit(1);
        }
        const reset = await resetStaffTotpByTelegramId(db, telegramId);
        process.stdout.write(
          reset
            ? 'готово: привязка стёрта, следующий вход покажет новый ключ\n'
            : 'нет такого сотрудника\n',
        );
        if (!reset) process.exit(1);
        break;
      }

      default:
        process.stdout.write(USAGE);
        process.exit(1);
    }
  } finally {
    await sql.end();
  }
}

main().catch(fail);
