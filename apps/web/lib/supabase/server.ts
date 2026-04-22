import 'server-only';

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

import { childLogger } from '@/lib/logger';
import { getServerEnv } from '@/lib/env';

/**
 * Supabase-клиент для RSC, Route Handlers и Server Actions.
 *
 * - Использует `cookies()` из `next/headers` для чтения/записи session-cookie.
 * - В RSC `cookies()` read-only — в этом случае `set/remove` становятся no-op и
 *   просто логируют предупреждение (Supabase может попытаться обновить сессию
 *   при чтении — это нормально).
 */

const log = childLogger('supabase.server');
let initialized = false;

export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const env = getServerEnv();
  const cookieStore = await cookies();

  if (!initialized) {
    log.debug({ event: 'supabase.server.init' });
    initialized = true;
  }

  return createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // RSC: cookies() read-only — просто игнорируем, middleware обновит сессию
          log.debug({ event: 'supabase.server.cookie.set_noop', name });
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: '', ...options });
        } catch {
          log.debug({ event: 'supabase.server.cookie.remove_noop', name });
        }
      },
    },
  });
}
