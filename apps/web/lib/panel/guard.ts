import 'server-only';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { serverEnv } from '@/lib/env.server';
import { childLogger } from '@/lib/logger';

import type { PanelActor } from './login';
import { canAccess, type PanelCapability } from './permissions';
import { readPanelActor } from './session';

/**
 * Гейт операций панели — единственная точка, через которую операция узнаёт,
 * «кто действует» и можно ли ему.
 *
 * ⚠️ Проверка прав живёт В ОПЕРАЦИИ, а не в маршруте (спека §4.3): разделы
 * владельца видны менеджеру в меню, поэтому единственная настоящая защита —
 * вот эта. Прямой запрос мимо интерфейса обязан получить отказ.
 */

const log = childLogger('panel.guard');

export type PanelGuardResult =
  | { ok: true; actor: PanelActor }
  | { ok: false; status: 401 | 403; error: 'unauthorized' | 'forbidden' };

export async function guardPanelOperation(
  capability: PanelCapability,
): Promise<PanelGuardResult> {
  const actor = await readPanelActor();
  if (!actor) return { ok: false, status: 401, error: 'unauthorized' };

  if (!canAccess(actor.role, capability)) {
    log.warn({ event: 'panel.guard.forbidden', staffId: actor.id, role: actor.role, capability });
    return { ok: false, status: 403, error: 'forbidden' };
  }

  return { ok: true, actor };
}

/**
 * Гейт СТРАНИЦЫ.
 *
 * ⚠️ Тип — размеченное объединение, и данных в запрещённой ветке НЕТ: вернуть
 * `{ actor, allowed }` значило бы, что страница обязана ПОМНИТЬ про `allowed`, а
 * забытая проверка молча отдаёт список заказов с именами, telegram и суммами
 * тому, кому раздел закрыт (находка ревью пачки 2). Здесь забыть нельзя:
 * `actor` для рендера содержимого достаётся только из ветки `allowed: true`.
 */
export type PanelPageAccess =
  | { allowed: true; actor: PanelActor }
  | { allowed: false; actor: PanelActor };

/**
 * Не вошёл — на страницу входа; вошёл, но раздел не его — `allowed: false`,
 * и экран показывает объясняющую заглушку ВНУТРИ панели (с меню и «кто вошёл»),
 * а не голый отказ.
 */
export async function panelPageAccess(capability: PanelCapability): Promise<PanelPageAccess> {
  const actor = await readPanelActor();
  if (!actor) redirect('/admin/login');

  if (!canAccess(actor.role, capability)) {
    log.warn({ event: 'panel.guard.section_forbidden', staffId: actor.id, capability });
    return { allowed: false, actor };
  }
  return { allowed: true, actor };
}

/**
 * Страница, которой не нужно отдельное право: любой вошедший сотрудник её
 * видит (стартовый экран «вы вошли как …»). Отдельная функция, чтобы не
 * просить у гейта случайное право ради получения актора.
 */
export async function requirePanelActor(): Promise<PanelActor> {
  const actor = await readPanelActor();
  if (!actor) redirect('/admin/login');
  return actor;
}

/**
 * Гейт `Origin` для МУТИРУЮЩИХ операций панели.
 *
 * ⚠️ `sameSite=lax` от этого НЕ защищает. Он блокирует кросс-САЙТОВЫЕ запросы, а
 * `admin.oplatishka.com` и `www.oplatishka.com` — один registrable domain, то
 * есть один site: cookie уедет. Инъекция на публичном сайте могла бы послать
 * `fetch` с `content-type: text/plain` — это «простой запрос», preflight'а нет,
 * ответ атакующему недоступен, но МУТАЦИЯ проходит, и в append-only журнале
 * останется имя ни в чём не виноватого оператора.
 *
 * Поэтому два барьера:
 *   1. `Origin` обязан совпадать с хостом панели. Браузер шлёт его на любой
 *      POST-`fetch`, подделать из JS нельзя;
 *   2. тело принимается только как `application/json` — этот content-type сам
 *      по себе требует preflight, который мы не разрешаем.
 *
 * Отсутствующий `Origin` тоже отвергаем: браузер его ставит всегда, а curl'ом
 * денежные операции панели проводить незачем.
 */
export async function assertPanelRequestOrigin(req: Request): Promise<boolean> {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    log.warn({ event: 'panel.guard.bad_content_type' });
    return false;
  }

  const origin = req.headers.get('origin');
  if (!origin) {
    log.warn({ event: 'panel.guard.missing_origin' });
    return false;
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host.split(':')[0]?.toLowerCase() ?? '';
  } catch {
    log.warn({ event: 'panel.guard.bad_origin' });
    return false;
  }

  // Сверяемся с ТЕМ ЖЕ хостом, что и гейт доступа: заданный `PANEL_HOST`, иначе
  // хост самого запроса (локальная разработка, где панель живёт на localhost).
  const expected =
    serverEnv.PANEL_HOST?.trim().toLowerCase() ||
    (await headers()).get('host')?.split(':')[0]?.toLowerCase();

  if (!expected || originHost !== expected) {
    log.warn({ event: 'panel.guard.foreign_origin' });
    return false;
  }
  return true;
}

/** Ответ на отказ — единый для всех операций панели. */
export function panelGuardResponse(
  result: Extract<PanelGuardResult, { ok: false }>,
): Response {
  return Response.json({ ok: false, error: result.error }, { status: result.status });
}
