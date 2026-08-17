import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { staff } from '../schema.ts';
import type { DB } from '../index.ts';
import { noopLogger, type RepoLogger } from './logger.ts';

/**
 * Репозиторий персонала — единственный доступ к таблице `staff`.
 *
 * `staff` держит вход в админ-панель (первый фактор — Telegram, второй — TOTP)
 * и адрес доставки уведомлений менеджеру. Отзыв доступа работает через
 * `is_active`, который панель проверяет на КАЖДОМ запросе: отключённый
 * сотрудник теряет доступ немедленно, а не по истечении cookie.
 *
 * Заведение сотрудника — скрипт `packages/db/scripts/manage-staff.ts`, не форма
 * в UI: операция редкая, а форма завела бы ещё один путь выдачи доступа.
 */

export type StaffRole = 'operator' | 'supervisor' | 'admin';

/**
 * Роли, которые РАЗДАЮТСЯ. `supervisor` остался в enum'е БД с прежней схемы, но
 * панель его не заводит (спека §2) — список назначаемых держим здесь, чтобы
 * скрипт заведения и панель не расходились каждый со своим представлением.
 */
export const ASSIGNABLE_STAFF_ROLES: readonly StaffRole[] = ['admin', 'operator'];

export type StaffMember = {
  id: string;
  email: string;
  displayName: string;
  role: StaffRole;
  telegramId: string | null;
  isActive: boolean;
  /** Секрет TOTP. НИКОГДА не уходит наружу дальше экрана привязки. */
  totpSecret: string | null;
  /** Пусто — приложение с кодами ещё не привязано. */
  totpConfirmedAt: Date | null;
  /** Последнее использованное окно TOTP — код одноразовый. */
  totpLastStep: number | null;
  lastLoginAt: Date | null;
  createdAt: Date;
};

export type UpsertStaffInput = {
  telegramId: string;
  email: string;
  displayName: string;
  role: StaffRole;
};

type StaffRow = typeof staff.$inferSelect;

function mapRow(row: StaffRow): StaffMember {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    telegramId: row.telegramId,
    isActive: row.isActive,
    totpSecret: row.totpSecret,
    totpConfirmedAt: row.totpConfirmedAt,
    totpLastStep: row.totpLastStep,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  };
}

/**
 * Сотрудник по Telegram-id (первый фактор входа).
 *
 * Отдаёт и ОТКЛЮЧЁННОГО: решение «отказать» принимает панель, и отказ должен
 * быть одинаковым для неизвестного id и для выключенного сотрудника —
 * различимые ответы рассказывали бы постороннему, кто у нас работает.
 */
export async function findStaffByTelegramId(
  db: DB,
  telegramId: string,
): Promise<StaffMember | null> {
  const rows = await db.select().from(staff).where(eq(staff.telegramId, telegramId)).limit(1);
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function findStaffById(db: DB, id: string): Promise<StaffMember | null> {
  const rows = await db.select().from(staff).where(eq(staff.id, id)).limit(1);
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Записать секрет TOTP перед показом QR.
 *
 * УСЛОВНЫЙ UPDATE (`totp_confirmed_at IS NULL`), а не безусловный: иначе
 * угнанный Telegram-аккаунт сотрудника позволял бы перевыпустить второй фактор
 * и тем самым его обойти — а он ровно для этого случая и нужен.
 *
 * Неподтверждённый секрет перезаписывается намеренно: привязка, брошенная на
 * середине, не должна оставлять валидный секрет, о котором никто не помнит.
 *
 * `false` — у сотрудника уже подтверждён TOTP, перевыдача только скриптом.
 */
export async function startStaffTotpEnrollment(
  db: DB,
  input: { staffId: string; secret: string },
  log: RepoLogger = noopLogger,
): Promise<boolean> {
  const rows = await db
    .update(staff)
    .set({ totpSecret: input.secret })
    .where(and(eq(staff.id, input.staffId), isNull(staff.totpConfirmedAt)))
    .returning({ id: staff.id });

  const started = rows.length > 0;
  // Секрет не логируем никогда — это второй фактор.
  log.info({
    event: started ? 'db.staff.totp_enrollment_started' : 'db.staff.totp_enrollment_rejected',
    staffId: input.staffId,
  });
  return started;
}

/**
 * Подтвердить привязку TOTP введённым кодом (код проверяет вызывающий).
 *
 * COMPARE-AND-SET по секрету, а не просто «подтверди этого сотрудника»: между
 * чтением строки и подтверждением соседняя вкладка могла пройти первый фактор
 * заново и перезаписать неподтверждённый секрет. Без сверки подтверждённым
 * оказался бы ЧУЖОЙ секрет — тот, владения которым никто не доказал, — а
 * повторная привязка после этого заблокирована, и живой сотрудник заперт до
 * ручного `db:staff reset-totp`.
 *
 * Условие `totp_confirmed_at IS NULL` оставляет операцию однократной.
 */
export async function confirmStaffTotp(
  db: DB,
  input: { staffId: string; expectedSecret: string },
  log: RepoLogger = noopLogger,
): Promise<boolean> {
  const rows = await db
    .update(staff)
    .set({ totpConfirmedAt: sql`now()` })
    .where(
      and(
        eq(staff.id, input.staffId),
        isNull(staff.totpConfirmedAt),
        eq(staff.totpSecret, input.expectedSecret),
      ),
    )
    .returning({ id: staff.id });

  const confirmed = rows.length > 0;
  log.info({
    event: confirmed ? 'db.staff.totp_confirmed' : 'db.staff.totp_confirm_skipped',
    staffId: input.staffId,
  });
  return confirmed;
}

/**
 * Занять 30-секундное окно TOTP — делает введённый код ОДНОРАЗОВЫМ.
 *
 * Без этого подсмотренный код (плечо, фишинговая страница входа, MITM-прокси)
 * переигрывается ещё около полутора минут и даёт полноценную 12-часовую
 * сессию. Условие строгое «больше предыдущего»: старое окно из допуска ±1 тоже
 * не должно приниматься повторно.
 *
 * Атомарно: один условный UPDATE, победитель гонки различим по `.returning()`.
 * `false` — это окно (или более позднее) уже использовано.
 */
export async function claimStaffTotpStep(
  db: DB,
  input: { staffId: string; step: number },
  log: RepoLogger = noopLogger,
): Promise<boolean> {
  const rows = await db
    .update(staff)
    .set({ totpLastStep: input.step })
    .where(
      and(
        eq(staff.id, input.staffId),
        sql`(${staff.totpLastStep} IS NULL OR ${staff.totpLastStep} < ${input.step})`,
      ),
    )
    .returning({ id: staff.id });

  const claimed = rows.length > 0;
  if (!claimed) {
    log.warn({ event: 'db.staff.totp_step_replayed', staffId: input.staffId });
  }
  return claimed;
}

/** Отметка успешного входа — колонка «когда заходил» на экране персонала. */
export async function touchStaffLastLogin(db: DB, staffId: string): Promise<void> {
  await db.update(staff).set({ lastLoginAt: sql`now()` }).where(eq(staff.id, staffId));
}

/**
 * Завести или обновить сотрудника по Telegram-id (скрипт заведения).
 *
 * ⚠️ Второй фактор НЕ трогается: повторный запуск скрипта с теми же данными
 * не должен молча снимать защиту у работающего сотрудника. Перевыдача TOTP —
 * отдельная явная команда `resetStaffTotpByTelegramId`.
 */
export async function upsertStaffByTelegramId(
  db: DB,
  input: UpsertStaffInput,
  log: RepoLogger = noopLogger,
): Promise<StaffMember> {
  const rows = await db
    .insert(staff)
    .values({
      telegramId: input.telegramId,
      email: input.email,
      displayName: input.displayName,
      role: input.role,
    })
    .onConflictDoUpdate({
      target: staff.telegramId,
      set: {
        email: input.email,
        displayName: input.displayName,
        role: input.role,
      },
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('upsertStaffByTelegramId: INSERT … ON CONFLICT не вернул строку');

  log.info({ event: 'db.staff.upserted', staffId: row.id, role: row.role });
  return mapRow(row);
}

/**
 * Перевыдача второго фактора (сотрудник потерял телефон): стираем и секрет, и
 * подтверждение — следующий вход снова покажет экран привязки.
 */
export async function resetStaffTotpByTelegramId(
  db: DB,
  telegramId: string,
  log: RepoLogger = noopLogger,
): Promise<boolean> {
  const rows = await db
    .update(staff)
    .set({ totpSecret: null, totpConfirmedAt: null, totpLastStep: null })
    .where(eq(staff.telegramId, telegramId))
    .returning({ id: staff.id });

  const reset = rows.length > 0;
  log.info({ event: reset ? 'db.staff.totp_reset' : 'db.staff.totp_reset_missed' });
  return reset;
}

/** Включить/отключить доступ. Отключение действует немедленно (см. заголовок). */
export async function setStaffActiveByTelegramId(
  db: DB,
  telegramId: string,
  isActive: boolean,
  log: RepoLogger = noopLogger,
): Promise<boolean> {
  const rows = await db
    .update(staff)
    .set({ isActive })
    .where(eq(staff.telegramId, telegramId))
    .returning({ id: staff.id });

  const changed = rows.length > 0;
  log.info({ event: changed ? 'db.staff.active_changed' : 'db.staff.active_change_missed', isActive });
  return changed;
}

/** Весь персонал, включая отключённых — экран `/admin/staff` показывает и их. */
export async function listStaff(db: DB): Promise<StaffMember[]> {
  const rows = await db.select().from(staff).orderBy(asc(staff.createdAt));
  return rows.map(mapRow);
}
