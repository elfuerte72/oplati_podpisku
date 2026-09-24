import { z } from 'zod';

import type { ChannelTarget } from '../config/env.ts';
import { CHANNEL_KEYS, smmConfig, type ChannelKey, type SmmConfig } from '../config/smm.config.ts';
import { previewKeyboard } from '../dialog/keyboards.ts';
import { TEXTS } from '../dialog/texts.ts';
import type { Keyboard } from '../dialog/types.ts';
import { BOT_RE, BRAND_RE } from '../lint/index.ts';
import type { Decision, Post } from '../store/index.ts';

/**
 * Куда пост можно опубликовать.
 *
 * Правило ОДНО на кнопки и на публикацию: кнопка канала, в который текст не
 * уйдёт, не показывается, а публикация перепроверяет то же самое — клавиатура
 * бывает старой, а колбэк подделывается.
 */

type AdsCarrier = Pick<Post, 'body' | 'buttonText' | 'buttonUrl'>;

/**
 * Бренд латиницей: название, домен `oplatishka.com`, имя бота. Линт канала
 * ловит кириллицу (`BRAND_RE`), а в канал без рекламы не должна пройти и
 * ссылка на сайт (ревью 24.09.2026). Без флага `g`: `.test` без состояния.
 */
const BRAND_LATIN_RE = /oplatishk/i;

/** Реклама Оплатишки в посте: бренд, сайт или бот в теле либо в собственной кнопке поста. */
export function mentionsProduct(post: AdsCarrier): boolean {
  const parts = [post.body ?? '', post.buttonText ?? '', post.buttonUrl ?? ''];
  return parts.some((part) => BRAND_RE.test(part) || BOT_RE.test(part) || BRAND_LATIN_RE.test(part));
}

export type ChannelVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Пускает ли канал этот текст. Сейчас правило одно: канал без рекламы не берёт упоминание Оплатишки. */
export function channelAllows(
  channel: ChannelTarget,
  post: AdsCarrier,
  config: SmmConfig = smmConfig,
): ChannelVerdict {
  if (!config.channels[channel.key].ads && mentionsProduct(post)) {
    return { ok: false, reason: 'канал без рекламы, а в тексте упоминание Оплатишки' };
  }
  return { ok: true };
}

export interface PublishTargets {
  readonly allowed: readonly ChannelTarget[];
  readonly refused: readonly { readonly channel: ChannelTarget; readonly reason: string }[];
}

/** Каналы, настроенные в окружении, разделённые на пускающие этот текст и нет. */
export function publishTargets(
  post: AdsCarrier,
  channels: readonly ChannelTarget[],
  config: SmmConfig = smmConfig,
): PublishTargets {
  const allowed: ChannelTarget[] = [];
  const refused: { channel: ChannelTarget; reason: string }[] = [];
  for (const channel of channels) {
    const verdict = channelAllows(channel, post, config);
    if (verdict.ok) allowed.push(channel);
    else refused.push({ channel, reason: verdict.reason });
  }
  return { allowed, refused };
}

const ApprovePayload = z.object({ channels: z.array(z.enum(CHANNEL_KEYS)).min(1).max(CHANNEL_KEYS.length) });

/**
 * Каналы из ПОСЛЕДНЕГО решения `approve` владельца. Решение без каналов (кнопка
 * «Опубликовать» до второго канала, старая клавиатура) — это основной канал:
 * так вели себя все подтверждения, записанные до этой правки.
 */
export function approvedChannels(decisions: readonly Decision[]): readonly ChannelKey[] {
  const approve = [...decisions].reverse().find((decision) => decision.kind === 'approve');
  if (approve === undefined) return [];
  const parsed = ApprovePayload.safeParse(approve.payload);
  if (!parsed.success) return ['main'];
  // Повтор ключа в решении не должен публиковать пост в один канал дважды.
  return [...new Set(parsed.data.channels)];
}

export interface PreviewControls {
  readonly text: string;
  readonly keyboard: Keyboard;
}

/**
 * Подпись и кнопки под превью поста канала. Одна функция на диалог и на
 * черновик по расписанию: разные сборки разошлись бы в том, какой канал
 * показывать, — а это ровно то место, где реклама уходит не туда.
 */
export function buildPreviewControls(input: {
  readonly post: AdsCarrier | undefined;
  readonly postId: string;
  readonly stamp: string;
  readonly channels: readonly ChannelTarget[];
  readonly note: 'ready' | 'cancelled';
  readonly prefix?: string;
  /** Первая строка вместо «Так пост уйдёт в канал» — у черновика по расписанию своя. */
  readonly headline?: string;
  readonly config?: SmmConfig;
}): PreviewControls {
  const config = input.config ?? smmConfig;
  const targets: PublishTargets =
    input.post === undefined
      ? { allowed: input.channels.slice(0, 1), refused: [] }
      : publishTargets(input.post, input.channels, config);
  const keyboard = previewKeyboard(
    input.postId,
    input.stamp,
    targets.allowed.map((channel) => ({ key: channel.key, label: channel.label })),
    input.prefix ?? '',
  );

  const lines: string[] = [
    input.note === 'cancelled' ? TEXTS.cancelled : (input.headline ?? TEXTS.previewReady),
  ];
  // Превью нарисовано для основного канала. Если среди доступных есть канал без
  // кнопки бота, это сказано прямо: превью обязано быть тем, что уйдёт.
  const withoutButton =
    targets.allowed.length > 1
      ? targets.allowed.filter((channel) => !config.channels[channel.key].botButton).map((channel) => channel.title)
      : [];
  if (withoutButton.length > 0) lines.push(TEXTS.noBotButton(withoutButton));
  for (const refused of targets.refused) lines.push(TEXTS.channelRefused(refused.channel.title, refused.reason));
  return { text: lines.join('\n'), keyboard };
}
