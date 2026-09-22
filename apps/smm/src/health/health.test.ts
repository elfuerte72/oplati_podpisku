import { describe, expect, it } from 'vitest';

import { createLogger } from '../logger.ts';
import type { Fetcher } from '../sources/index.ts';
import { openStore, type Store } from '../store/index.ts';
import { check, parseBalanceUsd, STUCK_GENERATING_MINUTES } from './check.ts';
import { formatHealth, notifyIfRed, troubleKey, type NotifyDeps } from './notify.ts';

const NOW = new Date('2026-09-22T10:00:00.000Z');
const publicDns = (): Promise<readonly string[]> => Promise.resolve(['93.184.216.34']);

function silent() {
  return createLogger({ level: 'fatal', stream: { write() {} } });
}

function balance(total: string | number): Fetcher {
  return () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: total }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
}

function baseDeps(store: Store, fetcher: Fetcher) {
  return {
    store,
    checkBot: () => Promise.resolve({ ok: true }),
    modelApiKey: 'sk-test',
    modelBalanceUrl: 'https://api.deepseek.com/user/balance',
    http: { fetcher, resolver: publicDns },
    now: () => NOW,
  };
}

describe('баланс модели', () => {
  it('разбирается из строки и числа', () => {
    expect(parseBalanceUsd({ balance_infos: [{ currency: 'USD', total_balance: '12.34' }] })).toBe(12.34);
    expect(parseBalanceUsd({ balance_infos: [{ currency: 'USD', total_balance: -0.03 }] })).toBe(-0.03);
    expect(parseBalanceUsd({ мусор: true })).toBeUndefined();
  });

  it('минус — красно, пять долларов — зелено', async () => {
    const store = openStore({ path: ':memory:' });

    const bad = await check(baseDeps(store, balance('-0.03')));
    expect(bad.level).toBe('red');
    expect(bad.items.find((item) => item.name === 'Модель')?.reason).toContain('-0.03');

    const good = await check(baseDeps(store, balance('5.0')));
    expect(good.level).toBe('green');
    store.close();
  });

  it('недоступный провайдер — красно, а не тишина', async () => {
    const store = openStore({ path: ':memory:' });
    const broken: Fetcher = () => Promise.resolve(new Response('нет', { status: 500 }));
    const status = await check(baseDeps(store, broken));
    expect(status.items.find((item) => item.name === 'Модель')?.level).toBe('red');
    store.close();
  });
});

describe('зависший конвейер', () => {
  it('пост в работе дольше пятнадцати минут — красно', async () => {
    const store = openStore({ path: ':memory:' });
    const post = store.posts.create({ platform: 'telegram' });
    const old = new Date(NOW.getTime() - (STUCK_GENERATING_MINUTES + 5) * 60 * 1000).toISOString();
    store.db.run('UPDATE posts SET status_changed_at = ? WHERE id = ?', old, post.id);

    const status = await check(baseDeps(store, balance('5.0')));
    expect(status.items.find((item) => item.name === 'Очередь')?.level).toBe('red');
    store.close();
  });

  it('свежий пост в работе — норма', async () => {
    const store = openStore({ path: ':memory:' });
    store.posts.create({ platform: 'telegram' });
    const status = await check(baseDeps(store, balance('5.0')));
    expect(status.items.find((item) => item.name === 'Очередь')?.level).toBe('green');
    store.close();
  });
});

describe('сообщение о здоровье', () => {
  function notifier(store: Store, sink: { text: string; toRoot?: boolean }[], fail = false): NotifyDeps {
    return {
      store,
      logger: silent(),
      send: (text, options) => {
        sink.push({ text, ...(options.toRoot === undefined ? {} : { toRoot: options.toRoot }) });
        if (fail && options.toRoot !== true) {
          return Promise.resolve({ ok: false, staleThread: true });
        }
        return Promise.resolve({ ok: true });
      },
      now: () => NOW,
    };
  }

  const red = {
    level: 'red' as const,
    items: [
      { name: 'Модель', level: 'red' as const, reason: 'на счету $-0.03 — прогон встанет' },
      { name: 'Бот', level: 'green' as const, reason: 'Telegram отвечает' },
    ],
  };
  const green = { level: 'green' as const, items: [{ name: 'Бот', level: 'green' as const, reason: 'ок' }] };

  it('два красных прогона подряд дают ОДНО сообщение', async () => {
    const store = openStore({ path: ':memory:' });
    const sink: { text: string }[] = [];
    expect(await notifyIfRed(red, notifier(store, sink))).toBe('sent');
    expect(await notifyIfRed(red, notifier(store, sink))).toBe('muted');
    expect(sink).toHaveLength(1);
    store.close();
  });

  it('новая поломка говорится сразу, а не прячется за первой', async () => {
    const store = openStore({ path: ':memory:' });
    const sink: { text: string }[] = [];
    await notifyIfRed(red, notifier(store, sink));
    const another = {
      level: 'red' as const,
      items: [{ name: 'База', level: 'red' as const, reason: 'не отвечает' }],
    };
    expect(await notifyIfRed(another, notifier(store, sink))).toBe('sent');
    expect(sink).toHaveLength(2);
    store.close();
  });

  it('зелёный после красного даёт «снова зелено» ровно один раз', async () => {
    const store = openStore({ path: ':memory:' });
    const sink: { text: string }[] = [];
    await notifyIfRed(red, notifier(store, sink));
    expect(await notifyIfRed(green, notifier(store, sink))).toBe('recovered');
    expect(await notifyIfRed(green, notifier(store, sink))).toBe('muted');
    expect(sink.filter((message) => message.text.includes('Снова зелено'))).toHaveLength(1);
    store.close();
  });

  it('протухшая тема — повтор в корень группы', async () => {
    const store = openStore({ path: ':memory:' });
    const sink: { text: string; toRoot?: boolean }[] = [];
    await notifyIfRed(red, notifier(store, sink, true));
    expect(sink).toHaveLength(2);
    expect(sink[1]?.toRoot).toBe(true);
    store.close();
  });

  it('в тексте — маркер, причины и «что делать»', () => {
    const text = formatHealth(red);
    expect(text).toContain('[SMM]');
    expect(text).toContain('Модель: на счету');
    expect(text).toContain('Что делать');
    expect(troubleKey(red)).toBe('Модель');
  });
});
