import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODEL_ROLES, smmConfig, type ModelRole, type SmmConfig } from '../config/smm.config.ts';

/**
 * Системные промпты ролей — файлами в `prompts/`, а не строками в коде: правка
 * формулировки не задевает логику, а логика не переписывает промпты. Грузятся
 * ОДИН раз при старте: недостающий файл должен ронять процесс сразу, а не на
 * первом посте в три часа ночи.
 *
 * `{{voice}}` в файле роли подставляется общим фрагментом о голосе канала —
 * чтобы правило «как звучит канал» жило в одном месте, а не в пяти копиях.
 */

const PROMPTS_DIR = fileURLToPath(new URL('./prompts', import.meta.url));
const VOICE_FILE = 'voice.md';
const VOICE_MARKER = '{{voice}}';

export type PromptSet = Readonly<Record<ModelRole, string>>;

function read(name: string): string {
  try {
    return readFileSync(join(PROMPTS_DIR, name), 'utf8').trim();
  } catch (error) {
    throw new Error(`промпт ${name} не прочитался: ${String(error)}`);
  }
}

export function loadPrompts(config: SmmConfig = smmConfig): PromptSet {
  const voice = read(VOICE_FILE);
  const entries = MODEL_ROLES.map((role) => {
    const body = read(config.prompts[role]);
    if (!body.includes(VOICE_MARKER)) return [role, body] as const;
    return [role, body.replace(VOICE_MARKER, voice)] as const;
  });
  return Object.fromEntries(entries) as PromptSet;
}

let cached: PromptSet | undefined;

/** Промпты процесса. Читаются один раз: файлы в образе не меняются на ходу. */
export function prompts(): PromptSet {
  cached ??= loadPrompts();
  return cached;
}
