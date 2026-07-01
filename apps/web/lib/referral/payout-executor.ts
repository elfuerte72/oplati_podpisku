import 'server-only';

import { type PayoutDestinationStored, type PayoutStatus } from '@oplati/types';

/**
 * Исполнение заявки на вывод — СЕМАФОР Этапа E. Реальный адаптер (Love&Pay
 * payout / крипто-провайдер) ждёт решения владельца «кто выплачивает» (D-REF-6):
 * контракт внешнего API не выдумываем (правило проекта). Пока — mock: помечает
 * заявку отправленной без внешнего вызова. Интерфейс фиксирует контракт, чтобы
 * врезка реального провайдера была точечной (новый класс `implements PayoutExecutor`).
 *
 * Оркестрация `settlePayout` — чистая (deps инъектируются): переводит заявку
 * `requested→processing`, зовёт исполнитель, по результату `processing→paid|rejected`.
 * НЕ подключена ни к крону, ни к операторскому endpoint — движение денег наружу
 * включаем только после подтверждения способа выплат. Здесь — тестируемый шов.
 */

export type PayoutExecutionRequest = {
  payoutId: string;
  /** Сумма к отправке партнёру (USD-центы, за вычетом комиссии). */
  netUsdCents: number;
  destination: PayoutDestinationStored;
};

export type PayoutExecutionResult =
  | { ok: true; providerRef: string }
  | { ok: false; reason: string };

export interface PayoutExecutor {
  readonly kind: string;
  execute(req: PayoutExecutionRequest): Promise<PayoutExecutionResult>;
}

/**
 * Mock-исполнитель: ничего не переводит, возвращает синтетический `providerRef`.
 * Осознанная заглушка до решения D-REF-6 — реальный перевод денег здесь НЕ идёт.
 */
export class MockPayoutExecutor implements PayoutExecutor {
  readonly kind = 'mock';

  async execute(req: PayoutExecutionRequest): Promise<PayoutExecutionResult> {
    return { ok: true, providerRef: `mock_${req.payoutId}` };
  }
}

/** Инъекция БД-перехода — держит `settlePayout` чистым и тестируемым без БД. */
export type PayoutTransitionFn = (
  payoutId: string,
  from: PayoutStatus,
  to: PayoutStatus,
) => Promise<{ applied: boolean }>;

export type SettlePayoutInput = {
  payoutId: string;
  netUsdCents: number;
  destination: PayoutDestinationStored;
};

export type SettlePayoutOutcome =
  | { status: 'paid'; providerRef: string }
  | { status: 'rejected'; reason: string }
  | { status: 'skipped'; reason: 'not_claimable' };

/**
 * Проводит одну заявку через исполнение. Сначала атомарно клеймит
 * `requested→processing` (защита от двойного исполнения: проигравший клейм видит
 * `applied=false` → `skipped`). Затем зовёт исполнитель и фиксирует терминальный
 * статус. Каждый переход валидируется машиной статусов (`canTransitionPayout`).
 */
export async function settlePayout(
  input: SettlePayoutInput,
  deps: { executor: PayoutExecutor; transition: PayoutTransitionFn },
): Promise<SettlePayoutOutcome> {
  const { executor, transition } = deps;

  // Атомарный клейм requested→processing (защита от двойного исполнения:
  // проигравший клейм видит applied=false → skipped). Все переходы здесь —
  // статические валидные литералы (машина статусов покрыта тестами @oplati/types);
  // БД-переход дополнительно форсит WHERE status=from.
  const claimed = await transition(input.payoutId, 'requested', 'processing');
  if (!claimed.applied) {
    return { status: 'skipped', reason: 'not_claimable' };
  }

  let result: PayoutExecutionResult;
  try {
    result = await executor.execute(input);
  } catch (err) {
    // Исполнитель БРОСИЛ вместо контрактного {ok:false} — неожиданный сбой. Не
    // оставляем заявку висеть в 'processing': переводим в 'rejected' (освобождает
    // сумму в балансе — учитываются только requested|processing|paid — партнёр
    // может повторить), затем пробрасываем ошибку для Sentry (правило проекта:
    // неожиданное не глотаем). ВНИМАНИЕ E2: реальный исполнитель обязан быть
    // идемпотентным (ключ выплаты на стороне провайдера), иначе ретрай после
    // неоднозначного сбоя («ушло, но упал ответ») задвоит перевод.
    await transition(input.payoutId, 'processing', 'rejected');
    throw err;
  }

  if (result.ok) {
    await transition(input.payoutId, 'processing', 'paid');
    return { status: 'paid', providerRef: result.providerRef };
  }
  await transition(input.payoutId, 'processing', 'rejected');
  return { status: 'rejected', reason: result.reason };
}
