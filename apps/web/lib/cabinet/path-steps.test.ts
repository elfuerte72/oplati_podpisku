import { describe, expect, it } from 'vitest';

import { buildPathSteps, siteHostFromUrl, serviceStepHint } from './path-steps.ts';

/**
 * Три шага пути клиента (тикеты 05, 06): «платишь рублями → получаешь карту →
 * сам оформляешь сервис». Одна функция на лист заказа и на вкладку «Карта»:
 * разъедься тексты — и клиент на одном экране читал бы «карта придёт в чат»,
 * а на соседнем «карта во вкладке».
 */

const states = (steps: ReturnType<typeof buildPathSteps>) => steps.map((s) => s.state);

describe('buildPathSteps — лист заказа (оплата впереди)', () => {
  const steps = buildPathSteps({
    stage: 'pay',
    service: 'ChatGPT',
    payText: '2 460 ₽',
    cardText: '$20',
    siteHost: 'chatgpt.com',
  });

  it('первый шаг текущий, два впереди', () => {
    expect(states(steps)).toEqual(['current', 'ahead', 'ahead']);
  });

  it('тексты шагов с суммой, долларами и сайтом сервиса', () => {
    expect(steps.map((s) => s.title)).toEqual([
      'Оплачиваешь заказ — 2 460 ₽',
      'Получаешь виртуальную карту с $20',
      'Сам оформляешь ChatGPT этой картой',
    ]);
    expect(steps.map((s) => s.hint)).toEqual([
      'здесь, через СБП или российской картой',
      'через пару минут — во вкладке «Карта» и в чате',
      'на chatgpt.com, в своём аккаунте',
    ]);
  });

  it('без суммы, долларов и сайта — нейтральные формулировки без пустых мест', () => {
    const bare = buildPathSteps({ stage: 'pay', service: null });
    expect(bare.map((s) => s.title)).toEqual([
      'Оплачиваешь заказ',
      'Получаешь виртуальную карту',
      'Сам оформляешь подписку этой картой',
    ]);
    expect(bare[2]?.hint).toBe('на сайте сервиса, в своём аккаунте');
  });

  it('номера шагов 1, 2, 3', () => {
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3]);
  });
});

describe('buildPathSteps — выпуск карты', () => {
  it('оплата сделана, карта текущая, сервис впереди', () => {
    const steps = buildPathSteps({
      stage: 'issuing',
      service: 'ChatGPT',
      payText: '2 460 ₽',
      cardText: '$20',
      siteHost: 'chatgpt.com',
    });
    expect(states(steps)).toEqual(['done', 'current', 'ahead']);
    expect(steps[0]?.title).toBe('Заказ оплачен — 2 460 ₽');
    expect(steps[1]?.title).toBe('Карта выпускается');
    expect(steps[1]?.hint).toBe('на неё ляжет $20');
  });

  it('при доливе на уже выпущенную карту шаг 2 говорит «пополняется», а не «выпускается»', () => {
    const steps = buildPathSteps({ stage: 'issuing', service: 'Claude', topUp: true });
    expect(steps[1]?.title).toBe('Карта пополняется');
  });
});

describe('buildPathSteps — остался один шаг', () => {
  it('два шага сделаны, третий текущий с подсказкой', () => {
    const steps = buildPathSteps({
      stage: 'use',
      service: 'ChatGPT',
      cardText: '$20',
      siteHost: 'chatgpt.com',
      useHint: 'VPN США · цена в долларах · через браузер, не приложение',
    });
    expect(states(steps)).toEqual(['done', 'done', 'current']);
    expect(steps.map((s) => s.title)).toEqual([
      'Заказ оплачен',
      'Карта выпущена — на ней $20',
      'Оформи ChatGPT на chatgpt.com',
    ]);
    expect(steps[2]?.hint).toBe('VPN США · цена в долларах · через браузер, не приложение');
  });

  it('без сайта — «на сайте сервиса»', () => {
    const steps = buildPathSteps({ stage: 'use', service: 'Midjourney' });
    expect(steps[2]?.title).toBe('Оформи Midjourney на сайте сервиса');
    expect(steps[2]?.hint).toBeNull();
  });
});

describe('buildPathSteps — «Как это работает» (карты ещё нет)', () => {
  it('все три шага впереди, без сумм', () => {
    const steps = buildPathSteps({ stage: 'explain' });
    expect(states(steps)).toEqual(['ahead', 'ahead', 'ahead']);
    expect(steps.map((s) => s.title)).toEqual([
      'Выбираешь сервис и платишь рублями',
      'Получаешь виртуальную карту в долларах',
      'Сам оформляешь подписку на сайте сервиса',
    ]);
  });
});

describe('ни один шаг не называет страну выпуска карты', () => {
  it('«виртуальная карта», а не «американская»', () => {
    for (const stage of ['explain', 'pay', 'issuing', 'use'] as const) {
      const text = JSON.stringify(buildPathSteps({ stage, service: 'ChatGPT' }));
      expect(text).not.toMatch(/американ|США/i);
    }
  });
});

describe('siteHostFromUrl', () => {
  it('домен без www и пути', () => {
    expect(siteHostFromUrl('https://chatgpt.com/#pricing')).toBe('chatgpt.com');
    expect(siteHostFromUrl('https://www.midjourney.com/account')).toBe('midjourney.com');
  });

  it('пусто и мусор — null', () => {
    expect(siteHostFromUrl(undefined)).toBeNull();
    expect(siteHostFromUrl(null)).toBeNull();
    expect(siteHostFromUrl('not a url')).toBeNull();
  });
});

describe('serviceStepHint', () => {
  it('VPN с локацией, валюта и «через браузер» при ссылке на сайт', () => {
    expect(
      serviceStepHint({
        requiresVpn: true,
        vpnLocation: 'США',
        requiredCurrency: 'USD',
        paymentUrl: 'https://chatgpt.com/',
      }),
    ).toBe('VPN США · цена в долларах · через браузер, не приложение');
  });

  it('VPN без локации и другая валюта', () => {
    expect(serviceStepHint({ requiresVpn: true, requiredCurrency: 'EUR' })).toBe('нужен VPN · цена в EUR');
  });

  it('без VPN и без валюты — только «через браузер», если есть сайт', () => {
    expect(serviceStepHint({ requiresVpn: false, paymentUrl: 'https://x.com/' })).toBe(
      'через браузер, не приложение',
    );
  });

  it('нечего сказать — null', () => {
    expect(serviceStepHint({ requiresVpn: false })).toBeNull();
    expect(serviceStepHint(null)).toBeNull();
  });
});
