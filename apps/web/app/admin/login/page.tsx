import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { TelegramLoginButton } from '@/components/panel/TelegramLoginButton';
import { serverEnv } from '@/lib/env.server';
import { lookupLabel } from '@/lib/panel/format';
import { LOGIN_ERROR_TEXT, PAGE_TITLES } from '@/lib/panel/labels';
import { readPanelActor } from '@/lib/panel/session';

/**
 * `/admin/login` — первый фактор.
 *
 * Паролей нет: сотрудник жмёт кнопку Telegram, подпись проверяет сервер, дальше
 * второй фактор. Причина отказа приезжает в `?e=` и показывается человеческим
 * текстом — но «нет такого сотрудника» и «сотрудник отключён» неразличимы по
 * построению (см. `lib/panel/login.ts`).
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: PAGE_TITLES.login };

export default async function PanelLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Уже вошёл — незачем показывать вход.
  if (await readPanelActor()) redirect('/admin');

  const params = await searchParams;
  const rawError = typeof params.e === 'string' ? params.e : undefined;
  // Код приходит из адреса, то есть снаружи, — читаем словарь через `lookupLabel`.
  const errorText = rawError ? (lookupLabel(LOGIN_ERROR_TEXT, rawError) ?? LOGIN_ERROR_TEXT.denied) : null;

  const botUsername = serverEnv.TELEGRAM_LOGIN_BOT_USERNAME;
  const authUrl = await buildAuthUrl();

  return (
    <div className="panel-login">
      <div className="panel-login-card">
        <div className="panel-card">
          <h1 className="panel-title">Панель Оплатишки</h1>
          <p className="panel-muted">
            Вход только для сотрудников: Telegram и код из приложения.
          </p>
        </div>

        {errorText ? <p className="panel-error">{errorText}</p> : null}

        <div className="panel-card">
          {botUsername ? (
            <TelegramLoginButton botUsername={botUsername} authUrl={authUrl} />
          ) : (
            <p className="panel-muted">
              Бот входа не настроен: нет `TELEGRAM_LOGIN_BOT_USERNAME`. Панель не пустит
              никого, пока переменная не задана.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Абсолютный адрес, на который виджет вернёт подпись. Берём заданный хост
 * панели, иначе — хост запроса (локальная разработка).
 */
async function buildAuthUrl(): Promise<string> {
  const path = '/api/panel/auth/telegram';
  const panelHost = serverEnv.PANEL_HOST;
  if (panelHost) return `https://${panelHost}${path}`;

  const store = await headers();
  const host = store.get('host') ?? 'localhost:3000';
  const proto = store.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}${path}`;
}
