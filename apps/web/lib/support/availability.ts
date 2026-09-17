import 'server-only';

import { isSupportAiConfigured } from '@oplati/agent';

import { serverEnv } from '@/lib/env.server';

/**
 * Доступен ли помощник поддержки — ЕДИНСТВЕННОЕ определение (crm-serious-fixes, Р3).
 *
 * Флаг `SUPPORT_AI_ENABLED` И ключ провайдера. Правило «флаг включён без ключа
 * ведёт себя как выключенный» живёт здесь, а не в каждом вызывающем: раньше это
 * были две проверки в разных местах (флаг — у бота, ключ — у порта модели), и
 * панель не читала ни одну — кнопка «Вернуть помощнику» отправляла клиента к
 * помощнику, которого нет.
 *
 * Зовут бот (вход в поддержку и ход), порт модели, экран обращения и операция
 * «Вернуть помощнику». Модуль бота панель не импортирует — поэтому функция
 * лежит здесь, а не в `lib/telegram/`.
 */
export function isSupportAiAvailable(): boolean {
  return serverEnv.SUPPORT_AI_ENABLED && isSupportAiConfigured();
}
