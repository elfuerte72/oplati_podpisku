import type { ChannelKey } from '../config/smm.config.ts';
import type { Db, SqlValue } from './db.ts';
import { isTransitionAllowed, type PostStatus } from './post-state.ts';
import { textShaOf } from './text-sha.ts';
import type {
  Decision,
  DecisionInput,
  NewPost,
  Platform,
  Post,
  PostPatch,
  TransitionInput,
  TransitionResult,
} from './types.ts';
import { ulid } from './ulid.ts';

interface PostRow {
  id: string;
  platform: string;
  status: string;
  rubric: string | null;
  layout: string | null;
  angle: string | null;
  cta: string;
  brief: string | null;
  source_url: string | null;
  source_title: string | null;
  dossier: string | null;
  body: string | null;
  text_sha: string | null;
  image_path: string | null;
  owner_text: number;
  judge: string | null;
  lint: string | null;
  rounds: number;
  tag: string | null;
  button_text: string | null;
  button_url: string | null;
  channel_message_id: number | null;
  channel: string | null;
  origin: string;
  angles: string | null;
  item_id: string | null;
  parent_post_id: string | null;
  publish_at: string | null;
  previewed_at: string | null;
  previewed_decision_id: number | null;
  published_at: string | null;
  withdrawn_at: string | null;
  rejected_at: string | null;
  status_changed_at: string;
  created_at: string;
  updated_at: string;
}

export type OnCorruptJson = (reason: string) => void;

function makeJsonParser(onCorrupt?: OnCorruptJson) {
  return (raw: string | null, column: string, id: string): unknown => {
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch (error) {
      // Негодный JSON — не повод ронять показ поста: поле просто не читается.
      // Но и молчать нельзя: записывает его только наш код через
      // JSON.stringify, значит это симптом ручной правки базы.
      onCorrupt?.(`пост ${id}: колонка ${column} не разобралась как JSON (${String(error)})`);
      return undefined;
    }
  };
}

function optional(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

/** Колонка для каждого поля патча: имя поля в JS не совпадает с именем в SQL. */
const PATCH_COLUMNS: Record<keyof PostPatch, string> = {
  rubric: 'rubric',
  layout: 'layout',
  angle: 'angle',
  cta: 'cta',
  brief: 'brief',
  sourceUrl: 'source_url',
  sourceTitle: 'source_title',
  dossier: 'dossier',
  body: 'body',
  imagePath: 'image_path',
  ownerText: 'owner_text',
  judge: 'judge',
  lint: 'lint',
  rounds: 'rounds',
  tag: 'tag',
  buttonText: 'button_text',
  buttonUrl: 'button_url',
  channelMessageId: 'channel_message_id',
  channel: 'channel',
  angles: 'angles',
  itemId: 'item_id',
  publishAt: 'publish_at',
};

const JSON_FIELDS = new Set<keyof PostPatch>(['dossier', 'judge', 'lint', 'angles']);

/**
 * Патч в SQL. `undefined` ПРОПУСКАЕТСЯ, а не превращается в NULL: без
 * `exactOptionalPropertyTypes` выражение `{ body: draft.body }` с пустым
 * значением типизируется, и колонка стиралась бы молча. Снять значение можно
 * только явным `null`.
 */
function patchToSql(patch: PostPatch): { columns: string[]; values: SqlValue[] } {
  const columns: string[] = [];
  const values: SqlValue[] = [];
  for (const [field, column] of Object.entries(PATCH_COLUMNS) as [keyof PostPatch, string][]) {
    if (!Object.hasOwn(patch, field)) continue;
    const value = patch[field];
    if (value === undefined) continue;
    columns.push(column);
    if (value === null) values.push(null);
    else if (JSON_FIELDS.has(field)) values.push(JSON.stringify(value));
    else if (typeof value === 'boolean') values.push(value ? 1 : 0);
    else if (typeof value === 'number') values.push(value);
    else values.push(String(value));

    // Отпечаток — производное тела: он пересчитывается ТОЙ ЖЕ записью, что
    // меняет тело. Правка тела механически обнуляет право на публикацию.
    if (field === 'body') {
      columns.push('text_sha');
      values.push(typeof value === 'string' ? textShaOf(value) : null);
    }
  }
  return { columns, values };
}

export interface PostsRepo {
  create(input: NewPost): Post;
  get(id: string): Post | undefined;
  /** Правка полей БЕЗ статуса. Статус двигает только `transition`. */
  patch(id: string, patch: PostPatch): Post | undefined;
  transition(input: TransitionInput): TransitionResult;
  /**
   * Запись решения БЕЗ смены статуса: выбор рубрики и угла — след в журнале,
   * а не шаг машины. Раньше это делалось самопереходом `status → status`, и
   * на черновике он бросал («переход draft → draft не разрешён») прямо в
   * горячем пути диалога, гася все эффекты после себя.
   */
  note(id: string, decision: DecisionInput): boolean;
  listByStatus(statuses: readonly PostStatus[], options?: { limit?: number }): Post[];
  /**
   * Последние вышедшие посты площадки (включая снятые владельцем), свежие
   * первыми: на них смотрит линт свежести и советник рубрик.
   */
  recentPublished(options?: { platform?: Platform; limit?: number; excludeId?: string }): Post[];
  findByMessageId(channel: ChannelKey, messageId: number): Post | undefined;
  /** Сколько черновиков по расписанию площадки ждут решения владельца. */
  countPendingAuto(platform: Platform): number;
  /** Копии поста для других каналов («в оба»). */
  channelCopies(parentId: string): Post[];
  /**
   * Копия поста для второго канала — ОДНИМ кликом «в оба». Проходит те же
   * статусы до `approved` и получает решение `approve` владельца с тем же
   * отпечатком: гейт публикации проверяет копию так же, как исходник.
   */
  createChannelCopy(input: {
    sourceId: string;
    channel: ChannelKey;
    approve: DecisionInput;
    publishAt?: string;
  }): TransitionResult;
  /**
   * Можно ли публиковать. Три условия, и все проверяются в БАЗЕ:
   *   1) пост показан владельцу и сейчас в оплатимом для публикации статусе;
   *   2) решение `approve` создано ПОСЛЕ показа превью — сравниваются
   *      идентификаторы решений, а не метки времени;
   *   3) отпечаток решения равен текущему отпечатку тела, а автор решения —
   *      владелец по его telegram id, а не по метке `actor`.
   */
  isApprovedForPublish(id: string, ownerId: number): boolean;
  decisions(id: string): Decision[];
  /** Посты, зависшие в статусе дольше срока: по времени ВХОДА в статус. */
  stuckInStatus(status: PostStatus, olderThanIso: string): Post[];
  publishPending(): Post[];
}

interface DecisionRow {
  id: number;
  post_id: string | null;
  kind: string;
  text_sha: string | null;
  actor: string;
  actor_id: number | null;
  payload: string | null;
  created_at: string;
}

export function createPostsRepo(db: Db, now: () => Date, onCorrupt?: OnCorruptJson): PostsRepo {
  const nowIso = (): string => now().toISOString();
  const parseJson = makeJsonParser(onCorrupt);

  function toPost(row: PostRow): Post {
    return {
      id: row.id,
      platform: row.platform as Platform,
      status: row.status as PostStatus,
      rubric: optional(row.rubric) as Post['rubric'],
      layout: optional(row.layout) as Post['layout'],
      angle: optional(row.angle),
      cta: row.cta as Post['cta'],
      brief: optional(row.brief),
      sourceUrl: optional(row.source_url),
      sourceTitle: optional(row.source_title),
      dossier: parseJson(row.dossier, 'dossier', row.id),
      body: optional(row.body),
      textSha: optional(row.text_sha),
      imagePath: optional(row.image_path),
      ownerText: row.owner_text === 1,
      judge: parseJson(row.judge, 'judge', row.id),
      lint: parseJson(row.lint, 'lint', row.id),
      rounds: row.rounds,
      tag: optional(row.tag),
      buttonText: optional(row.button_text),
      buttonUrl: optional(row.button_url),
      channelMessageId: row.channel_message_id ?? undefined,
      channel: optional(row.channel) as Post['channel'],
      origin: row.origin === 'auto' ? 'auto' : 'owner',
      angles: parseJson(row.angles, 'angles', row.id),
      itemId: optional(row.item_id),
      parentPostId: optional(row.parent_post_id),
      publishAt: optional(row.publish_at),
      previewedAt: optional(row.previewed_at),
      publishedAt: optional(row.published_at),
      withdrawnAt: optional(row.withdrawn_at),
      rejectedAt: optional(row.rejected_at),
      statusChangedAt: row.status_changed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function addDecision(
    postId: string | null,
    decision: DecisionInput,
    at: string,
  ): number {
    db.run(
      `INSERT INTO decisions (post_id, kind, text_sha, actor, actor_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      postId,
      decision.kind,
      decision.textSha ?? null,
      decision.actor,
      decision.actorId ?? null,
      decision.payload === undefined ? null : JSON.stringify(decision.payload),
      at,
    );
    const row = db.get<{ id: number }>('SELECT last_insert_rowid() AS id');
    if (row === undefined) throw new Error('решение не записалось');
    return row.id;
  }

  const repo: PostsRepo = {
    create(input) {
      const at = nowIso();
      const id = ulid(now().getTime());
      db.transaction(() => {
        db.run(
          `INSERT INTO posts (id, platform, status, rubric, layout, cta, brief, source_url,
             source_title, dossier, item_id, parent_post_id, origin, status_changed_at, created_at, updated_at)
           VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          input.platform,
          input.rubric ?? null,
          input.layout ?? null,
          input.cta ?? 'none',
          input.brief ?? null,
          input.sourceUrl ?? null,
          input.sourceTitle ?? null,
          input.dossier === undefined ? null : JSON.stringify(input.dossier),
          input.itemId ?? null,
          input.parentPostId ?? null,
          input.origin ?? 'owner',
          at,
          at,
          at,
        );
        addDecision(id, { kind: 'edit', actor: 'code', payload: { created: true } }, at);
      });
      const created = repo.get(id);
      if (created === undefined) throw new Error(`пост ${id} не записался`);
      return created;
    },

    get(id) {
      const row = db.get<PostRow>('SELECT * FROM posts WHERE id = ?', id);
      return row === undefined ? undefined : toPost(row);
    },

    patch(id, patch) {
      const { columns, values } = patchToSql(patch);
      if (columns.length === 0) return repo.get(id);
      const assignments = columns.map((column) => `${column} = ?`).join(', ');
      db.run(`UPDATE posts SET ${assignments}, updated_at = ? WHERE id = ?`, ...values, nowIso(), id);
      return repo.get(id);
    },

    transition({ id, from, to, decision, patch }) {
      if (from.length === 0) {
        throw new Error('переход без списка исходных статусов: условный UPDATE выродился бы');
      }
      for (const source of from) {
        if (!isTransitionAllowed(source, to)) {
          // Это ошибка программиста, а не состояние гонки: такой переход
          // не описан в машине, и молча его разрешать нельзя.
          throw new Error(`переход ${source} → ${to} не разрешён машиной статусов`);
        }
      }
      if (
        patch !== undefined &&
        Object.hasOwn(patch, 'body') &&
        decision.kind === 'approve' &&
        decision.actor === 'owner'
      ) {
        // Подтверждение относится к тексту, который владелец УВИДЕЛ. Менять
        // тело тем же переходом — способ опубликовать неувиденное.
        throw new Error('подтверждение владельца не может менять тело поста');
      }

      return db.transaction<TransitionResult>(() => {
        const at = nowIso();
        const { columns, values } = patchToSql(patch ?? {});
        // Метки времени ставит переход, а не вызывающий: забыть их иначе
        // ничего не мешает, а на них держатся гейт публикации и статистика.
        const stampColumns: string[] = ['status_changed_at'];
        if (to === 'previewed') stampColumns.push('previewed_at');
        if (to === 'published' || to === 'posted') stampColumns.push('published_at');
        if (to === 'withdrawn') stampColumns.push('withdrawn_at');
        if (to === 'rejected') stampColumns.push('rejected_at');

        const assignments = [
          'status = ?',
          ...columns.map((column) => `${column} = ?`),
          ...stampColumns.map((column) => `${column} = ?`),
          'updated_at = ?',
        ].join(', ');

        const placeholders = from.map(() => '?').join(', ');
        const { changes } = db.run(
          `UPDATE posts SET ${assignments} WHERE id = ? AND status IN (${placeholders})`,
          to,
          ...values,
          ...stampColumns.map(() => at),
          at,
          id,
          ...from,
        );

        if (changes === 0) {
          const actual = db.get<{ status: string }>('SELECT status FROM posts WHERE id = ?', id);
          return { ok: false, actual: (actual?.status as PostStatus | undefined) ?? null };
        }

        const decisionId = addDecision(id, decision, at);
        if (to === 'previewed') {
          // Показ превью запоминается решением, а не только временем: гейт
          // публикации сравнивает id, которые монотонны при любых часах.
          db.run('UPDATE posts SET previewed_decision_id = ? WHERE id = ?', decisionId, id);
        }
        const post = repo.get(id);
        if (post === undefined) throw new Error(`пост ${id} исчез внутри транзакции`);
        return { ok: true, post };
      });
    },

    note(id, decision) {
      const exists = db.get<{ id: string }>('SELECT id FROM posts WHERE id = ?', id);
      if (exists === undefined) return false;
      addDecision(id, decision, nowIso());
      return true;
    },

    listByStatus(statuses, options = {}) {
      if (statuses.length === 0) return [];
      const placeholders = statuses.map(() => '?').join(', ');
      const rows = db.all<PostRow>(
        `SELECT * FROM posts WHERE status IN (${placeholders})
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
        ...statuses,
        options.limit ?? 50,
      );
      return rows.map(toPost);
    },

    recentPublished(options = {}) {
      const rows = db.all<PostRow>(
        `SELECT * FROM posts
         WHERE status IN ('published', 'withdrawn', 'posted')
           AND platform = ?
           AND (? IS NULL OR id != ?)
         ORDER BY COALESCE(published_at, status_changed_at) DESC, id DESC
         LIMIT ?`,
        options.platform ?? 'telegram',
        options.excludeId ?? null,
        options.excludeId ?? null,
        options.limit ?? 10,
      );
      return rows.map(toPost);
    },

    findByMessageId(channel, messageId) {
      // Номер сообщения уникален только ВНУТРИ канала: у двух каналов свои счётчики.
      const row = db.get<PostRow>(
        "SELECT * FROM posts WHERE COALESCE(channel, 'main') = ? AND channel_message_id = ?",
        channel,
        messageId,
      );
      return row === undefined ? undefined : toPost(row);
    },

    countPendingAuto(platform) {
      const row = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM posts
          WHERE origin = 'auto' AND platform = ?
            AND status IN ('draft', 'linted', 'reviewed', 'previewed', 'handed')`,
        platform,
      );
      return row?.n ?? 0;
    },

    channelCopies(parentId) {
      return db
        .all<PostRow>(
          `SELECT * FROM posts
            WHERE parent_post_id = ? AND platform = 'telegram' AND channel IS NOT NULL
            ORDER BY created_at, id`,
          parentId,
        )
        .map(toPost);
    },

    createChannelCopy(input) {
      return db.transaction<TransitionResult>(() => {
        const source = repo.get(input.sourceId);
        if (source === undefined) return { ok: false, actual: null };
        if (source.platform !== 'telegram' || source.body === undefined || source.textSha === undefined) {
          return { ok: false, actual: source.status };
        }
        // Копия — ТОТ ЖЕ текст: отпечаток обязан совпасть с тем, что владелец
        // видел и подтвердил. Разошёлся — подтверждения под копией нет.
        if (input.approve.textSha !== source.textSha) return { ok: false, actual: source.status };

        const at = nowIso();
        const id = ulid(now().getTime());
        db.run(
          `INSERT INTO posts (id, platform, status, rubric, layout, angle, cta, brief, source_url,
             source_title, dossier, body, text_sha, image_path, owner_text, judge, lint, rounds,
             tag, button_text, button_url, item_id, parent_post_id, channel, origin, angles,
             status_changed_at, created_at, updated_at)
           SELECT ?, platform, 'draft', rubric, layout, angle, cta, brief, source_url,
             source_title, dossier, body, text_sha, image_path, owner_text, judge, lint, rounds,
             tag, button_text, button_url, item_id, id, ?, origin, angles, ?, ?, ?
             FROM posts WHERE id = ?`,
          id,
          input.channel,
          at,
          at,
          at,
          source.id,
        );
        addDecision(id, { kind: 'edit', actor: 'code', payload: { copyOf: source.id, channel: input.channel } }, at);

        // Копия идёт ТЕМ ЖЕ путём статусов, что исходный пост, — прямой записи
        // статуса нет нигде (канарейка). Проверки линта и редактора — те же, что
        // у исходника: текст тот же до буквы.
        const steps: { to: PostStatus; kind: DecisionInput['kind'] }[] = [
          { to: 'linted', kind: 'lint' },
          { to: 'reviewed', kind: 'judge' },
          { to: 'previewed', kind: 'preview' },
        ];
        let from: PostStatus = 'draft';
        for (const step of steps) {
          const moved = repo.transition({
            id,
            from: [from],
            to: step.to,
            decision: { kind: step.kind, actor: 'code', payload: { copyOf: source.id } },
          });
          if (!moved.ok) throw new Error(`копия ${id} не прошла ${from} → ${step.to}`);
          from = step.to;
        }
        return repo.transition({
          id,
          from: ['previewed'],
          to: 'approved',
          decision: input.approve,
          ...(input.publishAt === undefined ? {} : { patch: { publishAt: input.publishAt } }),
        });
      });
    },

    isApprovedForPublish(id, ownerId) {
      const row = db.get<{ found: number }>(
        `SELECT 1 AS found
           FROM decisions d
           JOIN posts p ON p.id = d.post_id
          WHERE d.post_id = ?
            AND d.kind = 'approve'
            AND d.actor = 'owner'
            AND d.actor_id = ?
            AND p.status IN ('previewed', 'approved')
            AND p.text_sha IS NOT NULL
            AND d.text_sha = p.text_sha
            AND p.previewed_decision_id IS NOT NULL
            AND d.id > p.previewed_decision_id
          LIMIT 1`,
        id,
        ownerId,
      );
      return row !== undefined;
    },

    decisions(id) {
      return db
        .all<DecisionRow>('SELECT * FROM decisions WHERE post_id = ? ORDER BY id', id)
        .map((row) => ({
          id: row.id,
          postId: optional(row.post_id),
          kind: row.kind as Decision['kind'],
          textSha: optional(row.text_sha),
          actor: row.actor as Decision['actor'],
          actorId: row.actor_id ?? undefined,
          payload: parseJson(row.payload, 'payload', id),
          createdAt: row.created_at,
        }));
    },

    stuckInStatus(status, olderThanIso) {
      return db
        .all<PostRow>(
          'SELECT * FROM posts WHERE status = ? AND status_changed_at < ? ORDER BY status_changed_at',
          status,
          olderThanIso,
        )
        .map(toPost);
    },

    publishPending() {
      return db
        .all<PostRow>(
          `SELECT * FROM posts WHERE status = 'approved' AND publish_at IS NOT NULL
           ORDER BY publish_at`,
        )
        .map(toPost);
    },
  };

  return repo;
}
