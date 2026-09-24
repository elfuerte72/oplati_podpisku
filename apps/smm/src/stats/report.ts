import { smmConfig, type ChannelKey, type RubricKey, type SmmConfig } from '../config/smm.config.ts';
import { IN_PROGRESS_STATUSES, type Store } from '../store/index.ts';

/**
 * Отчёт о канале: чистая функция над данными хранилища.
 *
 * Считает то, на что владелец может ПОВЛИЯТЬ: что выходит, чего не хватает,
 * во что это обходится и где редактор расходится с владельцем. Метрик ради
 * метрик здесь нет.
 */

export type ReportPeriod = '7d' | '30d';

export interface ReportInput {
  readonly store: Store;
  readonly period: ReportPeriod;
  /** Подписчиков сейчас. Приходит снаружи: это вызов Bot API, а не база. */
  readonly subscribers?: number;
  /**
   * Каналы публикации. Больше одного — строки по каждому каналу: сколько
   * вышло, подписчики, просмотры. Общая цифра по двум аудиториям разного
   * размера не говорит ни о какой из них.
   */
  readonly channels?: readonly {
    readonly key: ChannelKey;
    readonly title: string;
    readonly subscribers?: number;
  }[];
  readonly config?: SmmConfig;
  readonly now?: () => Date;
}

export interface ReportSection {
  readonly title: string;
  readonly lines: readonly string[];
}

export interface Report {
  readonly period: ReportPeriod;
  readonly empty: boolean;
  readonly sections: readonly ReportSection[];
}

const DAYS: Record<ReportPeriod, number> = { '7d': 7, '30d': 30 };

function money(usdMicros: number): string {
  return `$${(usdMicros / 1_000_000).toFixed(2)}`;
}

function share(count: number, total: number): string {
  return total === 0 ? '0%' : `${Math.round((count / total) * 100)}%`;
}

export function buildReport(input: ReportInput): Report {
  const config = input.config ?? smmConfig;
  const now = input.now ?? ((): Date => new Date());
  const at = now();
  const days = DAYS[input.period];
  const since = new Date(at.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const since30 = new Date(at.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { stats, views, usage } = input.store;

  // Обе цифры — про КАНАЛ: «вышло всего» без фильтра площадки читалось как
  // «в канал вышло столько», хотя туда попадали и посты Threads.
  const publishedTotal = stats.countPublished({ platform: 'telegram' });
  const publishedPeriod = stats.countPublished({ sinceIso: since, platform: 'telegram' });
  const threadsPosted = stats.countPublished({ platform: 'threads' });
  const drafts = stats.countByStatus(IN_PROGRESS_STATUSES);

  if (publishedTotal === 0 && drafts === 0) {
    return {
      period: input.period,
      empty: true,
      sections: [{ title: 'Канал', lines: ['Постов пока нет.'] }],
    };
  }

  const sections: ReportSection[] = [];
  const channels = input.channels ?? [];
  const multi = channels.length > 1;

  sections.push({
    title: multi ? 'Каналы' : 'Канал',
    lines: multi
      ? [
          ...channels.map((channel) => {
            const period = stats.countPublished({ sinceIso: since, channel: channel.key });
            const total = stats.countPublished({ channel: channel.key });
            const people = channel.subscribers === undefined ? '' : `, подписчиков ${channel.subscribers}`;
            return `${channel.title}: за ${days} дней ${period}, всего ${total}${people}`;
          }),
          `Выложено в Threads: ${threadsPosted}`,
          `Черновиков в работе: ${drafts}`,
        ]
      : [
          ...(input.subscribers === undefined ? [] : [`Подписчиков: ${input.subscribers}`]),
          `Вышло за ${days} дней: ${publishedPeriod}`,
          `Вышло всего: ${publishedTotal}`,
          `Выложено в Threads: ${threadsPosted}`,
          `Черновиков в работе: ${drafts}`,
        ],
  });

  const rubricRows = stats.rubricCounts(since30);
  const rubricTotal = rubricRows.reduce((sum, row) => sum + row.count, 0);
  const rubricLines = (Object.keys(config.rubrics) as RubricKey[]).map((key) => {
    const rubric = config.rubrics[key];
    const have = rubricRows.find((row) => row.rubric === key)?.count ?? 0;
    const plan = Math.round(rubric.share * 100);
    const gap = rubric.share * rubricTotal - have;
    // Дефицит называется словом, а не цветом: это рабочая подсказка, что
    // писать дальше.
    const note = gap >= 1 ? ` — в дефиците` : '';
    return `${rubric.title}: ${have} (${share(have, rubricTotal)} при плане ${plan}%)${note}`;
  });
  sections.push({ title: 'Рубрики за 30 дней', lines: rubricLines });

  const ctaRows = stats.ctaCounts(since30);
  const ctaTotal = ctaRows.reduce((sum, row) => sum + row.count, 0);
  const ctaTitles: Record<string, string> = {
    none: 'без рекламы',
    soft: 'мягкое упоминание',
    hard: 'прямая реклама',
  };
  sections.push({
    title: 'Реклама за 30 дней',
    lines:
      ctaTotal === 0
        ? ['Постов за месяц не было.']
        : ctaRows.map(
            (row) => `${ctaTitles[row.cta] ?? row.cta}: ${row.count} (${share(row.count, ctaTotal)})`,
          ),
  });

  const viewsSummary = views.summary(since);
  const perChannelViews = channels.map((channel) => {
    const summary = views.summary(since, channel.key);
    return summary.counted === 0
      ? `${channel.title}: счётчиков пока нет`
      : `${channel.title}: в среднем ${summary.average} (постов с цифрой: ${summary.counted})`;
  });
  sections.push({
    title: 'Просмотры',
    lines: multi
      ? [...perChannelViews, 'Свежий пост добирает просмотры день-два — сравнивать его с недельным рано.']
      :
      viewsSummary.counted === 0
        ? ['Счётчиков пока нет: витрина отдаёт цифру не сразу.']
        : [
            `В среднем: ${viewsSummary.average} (постов с цифрой: ${viewsSummary.counted})`,
            ...(viewsSummary.best === undefined ? [] : [`Лучший: ${viewsSummary.best.views}`]),
            'Свежий пост добирает просмотры день-два — сравнивать его с недельным рано.',
          ],
  });

  const means = stats.judgeMeans();
  sections.push({
    title: 'Редактор против владельца',
    lines:
      means.published === null && means.rejected === null
        ? ['Оценок пока нет.']
        : [
            `Средняя оценка вышедших: ${means.published ?? '—'}`,
            `Средняя оценка снятых: ${means.rejected ?? '—'}`,
            ...(means.published !== null && means.rejected !== null && means.rejected >= means.published
              ? ['Снятые посты редактор оценивал не ниже вышедших: он хвалит не то.']
              : []),
          ],
  });

  const month = at.toISOString().slice(0, 7);
  const spend = usage.sumByMonth(month);
  sections.push({
    title: `Расход на модель за ${month}`,
    lines: [
      `Всего: ${money(spend.usdMicros)} за ${spend.calls} вызовов${spend.hasUnknownPrice ? ' (часть по неизвестному тарифу — число оценочное)' : ''}`,
      ...spend.byRole
        .slice()
        .sort((a, b) => b.usdMicros - a.usdMicros)
        .map((row) => `${row.role}: ${money(row.usdMicros)} за ${row.calls}`),
    ],
  });

  return { period: input.period, empty: false, sections };
}

/** Потолок сообщения Telegram: отчёт обязан в него влезать. */
export const REPORT_MAX_CHARS = 4096;

/**
 * Отчёт одним сообщением. Не влезло — режем СЕКЦИЯМИ с конца и говорим об
 * этом вслух: молча обрезанный отчёт читается как «этих данных нет».
 */
export function renderReport(report: Report, maxChars = REPORT_MAX_CHARS): string {
  const header = `Отчёт за ${DAYS[report.period]} дней`;
  const blocks = report.sections.map(
    (section) => `<b>${section.title}</b>\n${section.lines.join('\n')}`,
  );

  const kept: string[] = [];
  let length = header.length;
  let dropped = 0;
  for (const block of blocks) {
    const addition = block.length + 2;
    if (length + addition > maxChars - 60) {
      dropped += 1;
      continue;
    }
    kept.push(block);
    length += addition;
  }

  const tail = dropped === 0 ? [] : [`Ещё ${dropped} раздел(а) не поместились.`];
  return [header, ...kept, ...tail].join('\n\n');
}
