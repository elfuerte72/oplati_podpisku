import { describe, expect, it, vi } from 'vitest';

import type { PayoutDestinationStored } from '@oplati/types';

import {
  MockPayoutExecutor,
  settlePayout,
  type PayoutExecutor,
  type PayoutTransitionFn,
} from './payout-executor.ts';

const destination: PayoutDestinationStored = {
  method: 'card_rub',
  panMasked: '****4242',
  last4: '4242',
  holderName: 'IVAN IVANOV',
};

/** Фейковый переход: разрешает клейм по флагу, пишет журнал вызовов. */
function makeTransition(claimApplied: boolean) {
  const calls: Array<{ from: string; to: string }> = [];
  const fn: PayoutTransitionFn = vi.fn(async (_id, from, to) => {
    calls.push({ from, to });
    if (from === 'requested' && to === 'processing') return { applied: claimApplied };
    return { applied: true };
  });
  return { fn, calls };
}

describe('MockPayoutExecutor', () => {
  it('возвращает синтетический providerRef, денег не двигает', async () => {
    const exec = new MockPayoutExecutor();
    expect(exec.kind).toBe('mock');
    const r = await exec.execute({ payoutId: 'p1', netUsdCents: 1930, destination });
    expect(r).toEqual({ ok: true, providerRef: 'mock_p1' });
  });
});

describe('settlePayout', () => {
  it('успех: requested→processing→paid', async () => {
    const { fn, calls } = makeTransition(true);
    const out = await settlePayout(
      { payoutId: 'p1', netUsdCents: 1930, destination },
      { executor: new MockPayoutExecutor(), transition: fn },
    );
    expect(out).toEqual({ status: 'paid', providerRef: 'mock_p1' });
    expect(calls).toEqual([
      { from: 'requested', to: 'processing' },
      { from: 'processing', to: 'paid' },
    ]);
  });

  it('клейм проигран (уже обрабатывается) → skipped, исполнитель не зовётся', async () => {
    const { fn, calls } = makeTransition(false);
    const executor: PayoutExecutor = { kind: 'spy', execute: vi.fn() };
    const out = await settlePayout(
      { payoutId: 'p1', netUsdCents: 1930, destination },
      { executor, transition: fn },
    );
    expect(out).toEqual({ status: 'skipped', reason: 'not_claimable' });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(calls).toEqual([{ from: 'requested', to: 'processing' }]);
  });

  it('исполнитель отказал → processing→rejected c причиной', async () => {
    const { fn, calls } = makeTransition(true);
    const executor: PayoutExecutor = {
      kind: 'failing',
      execute: vi.fn(async () => ({ ok: false as const, reason: 'provider_down' })),
    };
    const out = await settlePayout(
      { payoutId: 'p1', netUsdCents: 1930, destination },
      { executor, transition: fn },
    );
    expect(out).toEqual({ status: 'rejected', reason: 'provider_down' });
    expect(calls).toEqual([
      { from: 'requested', to: 'processing' },
      { from: 'processing', to: 'rejected' },
    ]);
  });
});
