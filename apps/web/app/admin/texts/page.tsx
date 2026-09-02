import type { Metadata } from 'next';

import {
  getDb,
  listFunnelTextOverrides,
  listRecentFunnelTextRevisions,
  type FunnelTextOverride,
  type FunnelTextRevision,
} from '@oplati/db';

import { FunnelTextEditor } from '@/components/panel/FunnelTextEditor';
import { LocalTime } from '@/components/panel/LocalTime';
import { PanelPageHeader } from '@/components/panel/PanelPageHeader';
import { PanelForbidden, PanelShell } from '@/components/panel/PanelShell';
import { FUNNEL_TEXTS, type FunnelTextGroup, type FunnelTextSpec } from '@/lib/funnel/texts';
import { panelPageAccess } from '@/lib/panel/guard';
import {
  CELL_TEXT,
  FUNNEL_TEXTS_TEXT,
  FUNNEL_TEXT_GROUP_TITLES,
  SECTION_TITLES,
} from '@/lib/panel/labels';

/**
 * `/admin/texts` — тексты воронки обратной связи (панель v2, ветка C):
 * группы → строки реестра, у каждой — текущее значение, пометка «изменено» с
 * датой и автором, подсказка подстановок и лимита, форма правки, история.
 *
 * Список ключей и дефолты — из реестра `lib/funnel/texts.ts`; переопределения и
 * история — из репозитория. Живое обновление выключено: страница — форма, и
 * перерисовка под руками уносила бы набранный текст.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: SECTION_TITLES.texts };

/** Сколько правок показывать под ключом. */
const HISTORY_PER_KEY = 20;

const GROUP_ORDER: readonly FunnelTextGroup[] = [
  'expired_survey',
  'start_survey',
  'order_rating',
  'referral_nudge',
  'common',
];

export default async function PanelTextsPage() {
  const access = await panelPageAccess('texts');
  if (!access.allowed) {
    return (
      <PanelShell actor={access.actor} current="/admin/texts" live={false}>
        <PanelForbidden title={SECTION_TITLES.texts} />
      </PanelShell>
    );
  }

  const db = getDb();
  const [overrideRows, revisionRows] = await Promise.all([
    listFunnelTextOverrides(db),
    // История — одним запросом по всем ключам и показывается у КАЖДОГО ключа,
    // где она есть: возврат к дефолту — тоже правка, и после него история не
    // должна исчезать с экрана. Потолок — последние 20 НА КЛЮЧ (оконная
    // функция в репозитории), поэтому редко правимый ключ не вытесняется.
    listRecentFunnelTextRevisions(db, HISTORY_PER_KEY),
  ]);
  const overrides = new Map<string, FunnelTextOverride>(overrideRows.map((o) => [o.key, o]));
  const revisions = new Map<string, FunnelTextRevision[]>();
  for (const rev of revisionRows) {
    const list = revisions.get(rev.key) ?? [];
    if (list.length < HISTORY_PER_KEY) list.push(rev);
    revisions.set(rev.key, list);
  }

  return (
    <PanelShell actor={access.actor} current="/admin/texts" live={false}>
      <PanelPageHeader title={SECTION_TITLES.texts}>
        <p className="panel-muted">{FUNNEL_TEXTS_TEXT.intro}</p>
      </PanelPageHeader>

      <div className="panel-grid" style={{ gridTemplateColumns: '1fr' }}>
        {GROUP_ORDER.map((group) => (
          <section className="panel-card" key={group}>
            <h2 className="panel-title">{FUNNEL_TEXT_GROUP_TITLES[group]}</h2>
            {FUNNEL_TEXTS.filter((spec) => spec.group === group).map((spec) => (
              <TextRow
                key={spec.key}
                spec={spec}
                override={overrides.get(spec.key) ?? null}
                history={revisions.get(spec.key) ?? []}
              />
            ))}
          </section>
        ))}
      </div>
    </PanelShell>
  );
}

function TextRow({
  spec,
  override,
  history,
}: {
  spec: FunnelTextSpec;
  override: FunnelTextOverride | null;
  history: FunnelTextRevision[];
}) {
  const value = override?.value ?? spec.defaultValue;
  return (
    <article className="panel-text-row">
      <header className="panel-text-row__head">
        <div>
          <h3 className="panel-text-row__title">{spec.title}</h3>
          <p className="panel-muted panel-text-row__hint">{spec.hint}</p>
        </div>
        <div className="panel-text-row__status">
          {override ? (
            <span className="panel-status panel-status--warn">
              {FUNNEL_TEXTS_TEXT.changed} · <LocalTime iso={override.updatedAt.toISOString()} />
              {' · '}
              {override.updatedByName ?? CELL_TEXT.noName}
            </span>
          ) : (
            <span className="panel-status panel-status--muted">{FUNNEL_TEXTS_TEXT.byDefault}</span>
          )}
        </div>
      </header>

      <p className="panel-muted panel-text-row__meta">
        <Placeholders spec={spec} />
        {' · '}
        {FUNNEL_TEXTS_TEXT.maxLength} {spec.maxLength} {FUNNEL_TEXTS_TEXT.characters}
        {' · '}
        <code>{spec.key}</code>
      </p>

      <FunnelTextEditor
        // Ключ включает версию значения: после сохранения или сброса сервер
        // рендерит строку заново, и без смены ключа React сохранил бы
        // содержимое поля — экран показывал бы «по умолчанию» рядом со старым
        // переопределением, а «Сохранить» тихо вернул бы его (code-review
        // 2026-09-02).
        key={`${spec.key}:${override?.updatedAt.toISOString() ?? 'default'}`}
        textKey={spec.key}
        value={value}
        isOverridden={override !== null}
        maxLength={spec.maxLength}
        singleLine={spec.kind === 'button' || spec.kind === 'answer'}
      />

      {history.length > 0 ? (
        <details className="panel-text-row__history">
          <summary>{FUNNEL_TEXTS_TEXT.history}</summary>
          <ul className="panel-timeline">
            {history.map((rev) => (
              <li key={rev.id}>
                <div className="panel-muted">
                  <LocalTime iso={rev.createdAt.toISOString()} /> · {rev.staffName ?? CELL_TEXT.noName}
                  {rev.newValue === null ? ` · ${FUNNEL_TEXTS_TEXT.historyReset}` : ''}
                </div>
                <div className="panel-text-row__diff">
                  <span className="panel-muted">{FUNNEL_TEXTS_TEXT.was}:</span>{' '}
                  <span className="panel-text-row__value">{rev.oldValue ?? FUNNEL_TEXTS_TEXT.byDefault}</span>
                </div>
                <div className="panel-text-row__diff">
                  <span className="panel-muted">{FUNNEL_TEXTS_TEXT.became}:</span>{' '}
                  <span className="panel-text-row__value">{rev.newValue ?? FUNNEL_TEXTS_TEXT.byDefault}</span>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

function Placeholders({ spec }: { spec: FunnelTextSpec }) {
  const { required, optional } = spec.placeholders;
  if (required.length === 0 && optional.length === 0) {
    return <>{FUNNEL_TEXTS_TEXT.placeholdersNone}</>;
  }
  return (
    <>
      {required.length > 0 ? (
        <>
          {FUNNEL_TEXTS_TEXT.placeholdersRequired}: {required.map((p) => `{${p}}`).join(', ')}
        </>
      ) : null}
      {required.length > 0 && optional.length > 0 ? ' · ' : null}
      {optional.length > 0 ? (
        <>
          {FUNNEL_TEXTS_TEXT.placeholdersOptional}: {optional.map((p) => `{${p}}`).join(', ')}
        </>
      ) : null}
    </>
  );
}
