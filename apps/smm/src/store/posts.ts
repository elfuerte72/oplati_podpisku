import type { Db, SqlValue } from './db.ts';
import { isTransitionAllowed, type PostStatus } from './post-state.ts';
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
  item_id: string | null;
  parent_post_id: string | null;
  publish_at: string | null;
  previewed_at: string | null;
  published_at: string | null;
  withdrawn_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    // Негодный JSON — не повод ронять показ поста: поле просто не читается.
    // Записывает его только наш код через JSON.stringify, так что это
    // симптом ручной правки базы, а не штатный путь.
    return undefined;
  }
}

function optional(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

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
    dossier: parseJson(row.dossier),
    body: optional(row.body),
    textSha: optional(row.text_sha),
    imagePath: optional(row.image_path),
    ownerText: row.owner_text === 1,
    judge: parseJson(row.judge),
    lint: parseJson(row.lint),
    rounds: row.rounds,
    tag: optional(row.tag),
    buttonText: optional(row.button_text),
    buttonUrl: optional(row.button_url),
    channelMessageId: row.channel_message_id ?? undefined,
    itemId: optional(row.item_id),
    parentPostId: optional(row.parent_post_id),
    publishAt: optional(row.publish_at),
    previewedAt: optional(row.previewed_at),
    publishedAt: optional(row.published_at),
    withdrawnAt: optional(row.withdrawn_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
  textSha: 'text_sha',
  imagePath: 'image_path',
  ownerText: 'owner_text',
  judge: 'judge',
  lint: 'lint',
  rounds: 'rounds',
  tag: 'tag',
  buttonText: 'button_text',
  buttonUrl: 'button_url',
  channelMessageId: 'channel_message_id',
  itemId: 'item_id',
  publishAt: 'publish_at',
};

const JSON_FIELDS = new Set<keyof PostPatch>(['dossier', 'judge', 'lint']);

function patchToSql(patch: PostPatch): { columns: string[]; values: SqlValue[] } {
  const columns: string[] = [];
  const values: SqlValue[] = [];
  for (const [field, column] of Object.entries(PATCH_COLUMNS) as [keyof PostPatch, string][]) {
    if (!Object.hasOwn(patch, field)) continue;
    const value = patch[field];
    columns.push(column);
    if (value === undefined || value === null) values.push(null);
    else if (JSON_FIELDS.has(field)) values.push(JSON.stringify(value));
    else if (typeof value === 'boolean') values.push(value ? 1 : 0);
    else if (typeof value === 'number') values.push(value);
    else values.push(String(value));
  }
  return { columns, values };
}

export interface PostsRepo {
  create(input: NewPost): Post;
  get(id: string): Post | undefined;
  /** Правка полей БЕЗ статуса. Статус двигает только `transition`. */
  patch(id: string, patch: PostPatch): Post | undefined;
  transition(input: TransitionInput): TransitionResult;
  listByStatus(statuses: readonly PostStatus[], options?: { limit?: number }): Post[];
  /**
   * Последние вышедшие посты площадки (включая снятые владельцем), свежие
   * первыми: на них смотрит линт свежести и советник рубрик.
   */
  recentPublished(options?: {
    platform?: Platform;
    limit?: number;
    excludeId?: string;
  }): Post[];
  findByMessageId(messageId: number): Post | undefined;
  /**
   * Можно ли публиковать: есть решение владельца `approve` с тем же отпечатком
   * текста, что у поста сейчас, и оно создано ПОСЛЕ показа превью этого текста.
   * Второй слой защиты рядом с автоматом диалога: слово «публикуй» текстом
   * кнопку не заменяет, а правка текста после клика обнуляет подтверждение.
   */
  isApprovedForPublish(id: string): boolean;
  decisions(id: string): Decision[];
  /** Посты, зависшие в статусе дольше срока: их ищет проверка здоровья. */
  stuckInStatus(status: PostStatus, olderThanIso: string): Post[];
  publishPending(): Post[];
}

interface DecisionRow {
  id: number;
  post_id: string | null;
  kind: string;
  text_sha: string | null;
  actor: string;
  payload: string | null;
  created_at: string;
}

export function createPostsRepo(db: Db, now: () => Date): PostsRepo {
  const nowIso = (): string => now().toISOString();

  function addDecision(postId: string | null, decision: DecisionInput, at: string): void {
    db.run(
      `INSERT INTO decisions (post_id, kind, text_sha, actor, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      postId,
      decision.kind,
      decision.textSha ?? null,
      decision.actor,
      decision.payload === undefined ? null : JSON.stringify(decision.payload),
      at,
    );
  }

  const repo: PostsRepo = {
    create(input) {
      const at = nowIso();
      const id = ulid(now().getTime());
      db.transaction(() => {
        db.run(
          `INSERT INTO posts (id, platform, status, rubric, layout, cta, brief, source_url,
             source_title, dossier, item_id, parent_post_id, created_at, updated_at)
           VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      db.run(
        `UPDATE posts SET ${assignments}, updated_at = ? WHERE id = ?`,
        ...values,
        nowIso(),
        id,
      );
      return repo.get(id);
    },

    transition({ id, from, to, decision, patch }) {
      for (const source of from) {
        if (!isTransitionAllowed(source, to)) {
          // Это ошибка программиста, а не состояние гонки: такой переход
          // не описан в машине, и молча его разрешать нельзя.
          throw new Error(`переход ${source} → ${to} не разрешён машиной статусов`);
        }
      }

      return db.transaction<TransitionResult>(() => {
        const at = nowIso();
        const { columns, values } = patchToSql(patch ?? {});
        // Метки времени ставит переход, а не вызывающий: забыть их иначе
        // ничего не мешает, а на них держатся гейт публикации и статистика.
        const stampColumns: string[] = [];
        if (to === 'previewed') stampColumns.push('previewed_at');
        if (to === 'published') stampColumns.push('published_at');
        if (to === 'withdrawn' || to === 'rejected') stampColumns.push('withdrawn_at');

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

        addDecision(id, decision, at);
        const post = repo.get(id);
        if (post === undefined) throw new Error(`пост ${id} исчез внутри транзакции`);
        return { ok: true, post };
      });
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
         ORDER BY COALESCE(published_at, updated_at) DESC, id DESC
         LIMIT ?`,
        options.platform ?? 'telegram',
        options.excludeId ?? null,
        options.excludeId ?? null,
        options.limit ?? 10,
      );
      return rows.map(toPost);
    },

    findByMessageId(messageId) {
      const row = db.get<PostRow>('SELECT * FROM posts WHERE channel_message_id = ?', messageId);
      return row === undefined ? undefined : toPost(row);
    },

    isApprovedForPublish(id) {
      const row = db.get<{ found: number }>(
        `SELECT 1 AS found
           FROM decisions d
           JOIN posts p ON p.id = d.post_id
          WHERE d.post_id = ?
            AND d.kind = 'approve'
            AND d.actor = 'owner'
            AND p.text_sha IS NOT NULL
            AND d.text_sha = p.text_sha
            AND p.previewed_at IS NOT NULL
            AND d.created_at >= p.previewed_at
          LIMIT 1`,
        id,
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
          payload: parseJson(row.payload),
          createdAt: row.created_at,
        }));
    },

    stuckInStatus(status, olderThanIso) {
      return db
        .all<PostRow>(
          'SELECT * FROM posts WHERE status = ? AND updated_at < ? ORDER BY updated_at',
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
