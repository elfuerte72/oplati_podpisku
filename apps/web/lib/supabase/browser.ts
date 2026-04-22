import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

import { childLogger } from '@/lib/logger';
import { getServerEnv } from '@/lib/env';

/**
 * Supabase-клиент для браузера (Client Components).
 *
 * Использует анонимный ключ — RLS должен быть включён на всех таблицах.
 * Никогда не принимает `service_role`.
 *
 * ВАЖНО: singleton-кеширование, чтобы не создавать новый клиент на каждый рендер.
 */

const log = childLogger('supabase.browser');

let cached: SupabaseClient | null = null;

export function createSupabaseBrowserClient(): SupabaseClient {
  if (cached) return cached;

  // NB: getServerEnv читает process.env; в браузере доступны только inlined NEXT_PUBLIC_*.
  // Здесь намеренно читаем SUPABASE_URL/ANON_KEY через публичные алиасы:
  // на клиенте они должны быть проброшены через NEXT_PUBLIC_ обёртку.
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    (typeof window === 'undefined' ? getServerEnv().SUPABASE_URL : '');
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    (typeof window === 'undefined' ? getServerEnv().SUPABASE_ANON_KEY : '');

  if (!url || !anonKey) {
    throw new Error(
      'Supabase browser client: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY ' +
        'must be defined. See docs/env-vars.md.',
    );
  }

  cached = createBrowserClient(url, anonKey);
  log.debug({ event: 'supabase.browser.ready' });
  return cached;
}
