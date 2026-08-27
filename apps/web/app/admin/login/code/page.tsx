import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { lookupLabel } from '@/lib/panel/format';
import { ACTION_TITLES, CODE_ERROR_TEXT, PAGE_TITLES } from '@/lib/panel/labels';
import { buildStaffOtpAuthUri } from '@/lib/panel/login';
import { readPendingStaffForEnrollment } from '@/lib/panel/session';

/**
 * `/admin/login/code` — второй фактор.
 *
 * Один экран на два случая: у кого приложение с кодами ещё не привязано, тот
 * сначала видит секрет и otpauth-URI; у привязанного — только поле кода.
 *
 * Секрет читается из базы по промежуточному токену, а не приезжает в адресе:
 * ссылка с секретом осела бы в истории браузера и в логах прокси.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: PAGE_TITLES.loginCode };

export default async function PanelCodePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const staff = await readPendingStaffForEnrollment();
  if (!staff) redirect('/admin/login?e=restart');
  if (!staff.isActive) redirect('/admin/login?e=denied');

  const params = await searchParams;
  const rawError = typeof params.e === 'string' ? params.e : undefined;
  const errorText = lookupLabel(CODE_ERROR_TEXT, rawError);

  // Привязка не завершена — показываем секрет. После подтверждения этот блок
  // не появится больше никогда: `totp_confirmed_at` заполнен.
  const secret = staff.confirmed ? null : staff.totpSecret;

  return (
    <div className="panel-login">
      <div className="panel-login-card">
        {secret ? (
          <div className="panel-card">
            <h1 className="panel-title">Привяжите приложение с кодами</h1>
            <p className="panel-muted">
              Добавьте ключ в Google Authenticator или совместимое приложение и введите код,
              который оно покажет. Ключ виден до первого подтверждения — после него панель
              не покажет его больше никогда.
            </p>
            <p style={{ marginTop: 12 }}>
              <span className="panel-muted">Ключ</span>
              <code className="panel-secret">{secret}</code>
            </p>
            <p style={{ marginTop: 12 }}>
              <span className="panel-muted">Ссылка для приложения</span>
              <code className="panel-secret">
                {buildStaffOtpAuthUri({ email: staff.email, totpSecret: secret })}
              </code>
            </p>
          </div>
        ) : (
          <div className="panel-card">
            <h1 className="panel-title">Код из приложения</h1>
            <p className="panel-muted">Шесть цифр — они меняются каждые 30 секунд.</p>
          </div>
        )}

        {errorText ? <p className="panel-error">{errorText}</p> : null}

        <form className="panel-card" method="post" action="/api/panel/auth/totp">
          <label htmlFor="code" className="panel-muted">
            Код
          </label>
          <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'center' }}>
            <input
              id="code"
              name="code"
              className="panel-input panel-code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
            />
            <button type="submit" className="panel-button">
              {ACTION_TITLES.signIn}
            </button>
          </div>
        </form>

        <p className="panel-muted">
          Если приложение с кодами потеряно — перевыдачу делает владелец.
        </p>
      </div>
    </div>
  );
}
