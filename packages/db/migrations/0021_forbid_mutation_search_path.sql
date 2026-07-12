-- Фикс Supabase security advisor «function_search_path_mutable» (аудит
-- 2026-07-11 F-09): у forbid_order_events_mutation (миграция 0018) search_path
-- наследовался от роли — стандартный вектор подмены объектов через схему,
-- контролируемую атакующим. Тело функции не обращается к объектам БД (только
-- RAISE EXCEPTION), поэтому пустой search_path безопасен и ничего не ломает.
ALTER FUNCTION public.forbid_order_events_mutation() SET search_path = '';
