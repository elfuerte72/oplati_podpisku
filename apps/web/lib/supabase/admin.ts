import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { childLogger } from '@/lib/logger';
import { getServerEnv } from '@/lib/env';

/**
 * Admin-клиент Supabase с `service_role`-ключом.
 *
 * - ОБХОДИТ RLS. Использовать только для server-side критичных операций
 *   (webhook'и платежей, фоновые задачи, миграции данных).
 * - `import 'server-only'` гарантирует, что клиент никогда не попадёт в браузер-бандл.
 * - Singleton — `service_role` не должен проксироваться через cookies.
 */

const log = childLogger('supabase.admin');
let cached: SupabaseClient | null = null;

export function createSupabaseAdminClient(): SupabaseClient {
  if (cached) return cached;

  const env = getServerEnv();
  cached = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  log.debug({ event: 'supabase.admin.ready' });
  return cached;
}
