import type { StaffMember } from '@oplati/db';

import { verifyLoginWidgetPayload } from './telegram-login';
import { verifyPanelToken } from './token';
import { buildOtpAuthUri, generateTotpSecret, verifyTotp } from './totp';

/**
 * Имя выпускающего в otpauth-URI — так приложение с кодами подписывает строку.
 * ЕДИНСТВЕННОЕ место: URI строит только `buildStaffOtpAuthUri`, иначе issuer
 * разъехался бы между экраном привязки и всем остальным, и сотрудник получил бы
 * в приложении ключ с чужой подписью.
 */
const TOTP_ISSUER = 'Оплатишка';

/** otpauth-URI для экрана привязки. Единственная точка сборки. */
export function buildStaffOtpAuthUri(staff: { email: string; totpSecret: string }): string {
  return buildOtpAuthUri({ secret: staff.totpSecret, account: staff.email, issuer: TOTP_ISSUER });
}

/**
 * Ядро входа в панель: два фактора и проверка живой сессии.
 *
 * Модуль намеренно не знает ни про Next, ни про cookie, ни про базу — зависимости
 * приходят параметрами. Это единственный способ проверить тестами то, ради чего
 * он существует: что отключённый сотрудник и неизвестный получают ОДИНАКОВЫЙ
 * отказ, что между факторами доступа нет и что `is_active` смотрят на каждом
 * запросе, а не только при входе.
 *
 * Отдельно про формулировку отказов: наружу уходит `denied` без подробностей.
 * Различимые ответы («такого нет» / «отключён») рассказывали бы постороннему,
 * кто у нас работает, — а первый фактор здесь публичная кнопка.
 */

/**
 * «Кто действует» — сотрудник в том виде, в каком его можно отдавать наружу.
 *
 * Отдельный тип, а не `StaffMember`, ровно из-за одного поля: `totp_secret`.
 * Строка сотрудника несёт второй фактор, и любой роут, вернувший её целиком в
 * JSON, отдал бы второй фактор в браузер. Сужение здесь делает такую ошибку
 * невозможной, а не «замеченной на ревью».
 */
export type PanelActor = {
  id: string;
  email: string;
  displayName: string;
  role: StaffMember['role'];
  telegramId: string | null;
  lastLoginAt: Date | null;
};

export function toPanelActor(staff: StaffMember): PanelActor {
  return {
    id: staff.id,
    email: staff.email,
    displayName: staff.displayName,
    role: staff.role,
    telegramId: staff.telegramId,
    lastLoginAt: staff.lastLoginAt,
  };
}

/**
 * ⚠️ Секрет и otpauth-URI здесь НЕ возвращаются. Их показывает экран ввода кода,
 * читая `staff.totp_secret` из базы: результат этой функции уходит в роут, а
 * роут — в редирект и в лог. Второй источник того же секрета означал бы второй
 * способ его выронить.
 */
export type BeginLoginResult =
  | { ok: true; stage: 'enroll' | 'totp'; actor: PanelActor }
  | {
      ok: false;
      reason: 'denied' | 'bad_signature' | 'expired' | 'malformed' | 'not_configured' | 'replayed';
    };

/**
 * Первый фактор: подпись Telegram Login Widget → сотрудник → решение, какой
 * экран показать (привязка приложения или ввод кода).
 *
 * Доступа этот шаг НЕ выдаёт: вызывающий кладёт только промежуточный токен
 * (`purpose: 'pending'`), который сессией не является по построению.
 */
export async function beginPanelLogin(params: {
  payload: unknown;
  botToken: string;
  findStaffByTelegramId: (telegramId: string) => Promise<StaffMember | null>;
  startTotpEnrollment: (input: { staffId: string; secret: string }) => Promise<boolean>;
  /**
   * Занять подпись виджета один раз. `false` — этот же payload уже применялся.
   *
   * Без одноразовости он переигрывается все пять минут своей жизни, а лежит он
   * в адресной строке и в истории браузера. Хуже того, повтор ПЕРЕВЫДАЁТ ещё не
   * подтверждённый секрет: сотрудник, нажавший «назад» после сканирования QR,
   * получал новый секрет и молчаливое «код не подошёл» на всё, что показывает
   * его приложение.
   */
  claimPayloadOnce?: (signature: string) => Promise<boolean>;
  nowSeconds?: number;
}): Promise<BeginLoginResult> {
  const verified = verifyLoginWidgetPayload(params.payload, params.botToken, params.nowSeconds);
  if (!verified.ok) return { ok: false, reason: verified.reason };

  // ПОСЛЕ проверки подписи: до неё `hash` — произвольная строка от кого угодно,
  // и «занимать» её значило бы дать постороннему забивать хранилище.
  if (params.claimPayloadOnce && !(await params.claimPayloadOnce(verified.signature))) {
    return { ok: false, reason: 'replayed' };
  }

  const staff = await params.findStaffByTelegramId(verified.telegramId);
  // Три разных причины — один ответ (см. заголовок модуля).
  if (!staff || !staff.isActive || !staff.telegramId) return { ok: false, reason: 'denied' };

  if (staff.totpConfirmedAt) return { ok: true, stage: 'totp', actor: toPanelActor(staff) };

  // Привязка ещё не доведена до кода: выдаём НОВЫЙ секрет. Брошенная на
  // середине привязка не должна оставлять валидный секрет, о котором никто не
  // помнит.
  const secret = generateTotpSecret();
  const started = await params.startTotpEnrollment({ staffId: staff.id, secret });
  // База отказала — значит TOTP у сотрудника уже подтверждён (гонка двух
  // вкладок). Впускать по неподтверждённому секрету нельзя.
  if (!started) return { ok: false, reason: 'denied' };

  return { ok: true, stage: 'enroll', actor: toPanelActor(staff) };
}

export type CompleteLoginResult =
  | { ok: true; actor: PanelActor }
  | { ok: false; reason: 'denied' | 'bad_code' | 'enrollment_lost' | 'code_used' };

/**
 * Второй фактор: шестизначный код.
 *
 * Сотрудник перечитывается из базы ЗАНОВО: между двумя факторами его могли
 * отключить, и промежуточный токен об этом ничего не знает.
 */
export async function completePanelLogin(params: {
  staffId: string;
  code: string;
  findStaffById: (id: string) => Promise<StaffMember | null>;
  /** Подтверждение привязки. Сверяет секрет — см. `confirmStaffTotp`. */
  confirmTotp: (input: { staffId: string; expectedSecret: string }) => Promise<boolean>;
  /** Занять окно кода. `false` — код уже использован (переигровка). */
  claimTotpStep: (input: { staffId: string; step: number }) => Promise<boolean>;
  touchLastLogin: (staffId: string) => Promise<void>;
  nowSeconds?: number;
}): Promise<CompleteLoginResult> {
  const staff = await params.findStaffById(params.staffId);
  if (!staff || !staff.isActive) return { ok: false, reason: 'denied' };
  if (!staff.totpSecret) return { ok: false, reason: 'enrollment_lost' };

  const verified = verifyTotp(staff.totpSecret, params.code, params.nowSeconds);
  if (!verified.ok) {
    // Секрет в базе не разбирается — это НАША авария, а не промах сотрудника.
    // Отдаём её отдельной причиной: вызывающий залогирует, а человека вернём на
    // привязку, а не оставим гадать над «код не подошёл».
    return { ok: false, reason: verified.reason === 'bad_secret' ? 'enrollment_lost' : 'bad_code' };
  }

  // Окно занимается ДО выдачи доступа: код одноразовый, иначе подсмотренные
  // шесть цифр живут ещё полторы минуты и дают полноценную сессию.
  if (!(await params.claimTotpStep({ staffId: staff.id, step: verified.step }))) {
    return { ok: false, reason: 'code_used' };
  }

  // Первый успешный код и подтверждает привязку. Для уже привязанного вызова
  // нет — условный UPDATE вернул бы false, но лишний запрос в БД на каждом
  // входе не нужен.
  if (!staff.totpConfirmedAt) {
    await params.confirmTotp({ staffId: staff.id, expectedSecret: staff.totpSecret });
  }
  await params.touchLastLogin(staff.id);

  return { ok: true, actor: toPanelActor(staff) };
}

export type SessionAuthResult =
  | { ok: true; actor: PanelActor }
  | {
      ok: false;
      reason: 'no_session' | 'bad_session' | 'expired' | 'revoked' | 'not_configured';
    };

/**
 * Проверка сессии — на КАЖДОМ запросе панели.
 *
 * Таблицы сессий нет, поэтому отзыв доступа держится именно здесь: сотрудник
 * перечитывается из базы, и `is_active = false` закрывает панель немедленно,
 * не дожидаясь конца двенадцатичасовой cookie.
 */
export async function authorizeSessionToken(params: {
  token: string | undefined;
  secret: string;
  findStaffById: (id: string) => Promise<StaffMember | null>;
  nowSeconds?: number;
}): Promise<SessionAuthResult> {
  if (!params.token) return { ok: false, reason: 'no_session' };

  const verified = verifyPanelToken(params.token, params.secret, {
    purpose: 'session',
    nowSeconds: params.nowSeconds,
  });
  if (!verified.ok) {
    if (verified.reason === 'expired') return { ok: false, reason: 'expired' };
    if (verified.reason === 'not_configured') return { ok: false, reason: 'not_configured' };
    // `wrong_purpose` (подложили промежуточный токен) и подделка — одно и то же
    // для вызывающего: сессии нет.
    return { ok: false, reason: 'bad_session' };
  }

  const staff = await params.findStaffById(verified.staffId);
  if (!staff || !staff.isActive) return { ok: false, reason: 'revoked' };

  return { ok: true, actor: toPanelActor(staff) };
}
