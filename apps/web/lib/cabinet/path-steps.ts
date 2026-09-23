import type { ServicePaymentInstructions } from '@oplati/types';

/**
 * Три шага пути клиента (трек miniapp-tabs, тикеты 05 и 06):
 *
 *   1. платишь рублями → 2. получаешь виртуальную карту в долларах →
 *   3. сам оформляешь подписку на сайте сервиса этой картой.
 *
 * Разбор пути клиента (2026-09-23) показал, что третий шаг клиенты не видят:
 * «Карта выдана» читалось как «подписка подключена». Поэтому шаги рисуются
 * везде, где клиент принимает решение — на листе заказа до оплаты, на вкладке
 * «Карта» во время выпуска и после него. Тексты — одной функцией: разъедься
 * они, и клиент на одном экране читал бы одно, а на соседнем другое.
 *
 * ⚠️ Страну выпуска карты не называем нигде («виртуальная карта»). VPN-локация
 * из правил сервиса — не страна карты, её называть можно.
 */

export type PathStepState = 'done' | 'current' | 'ahead';

export type PathStep = {
  n: 1 | 2 | 3;
  title: string;
  hint: string | null;
  state: PathStepState;
};

/**
 * Где клиент на пути:
 *  - `explain` — карты нет, объясняем устройство (вкладка «Карта», пусто);
 *  - `pay` — заказ не оплачен (лист заказа);
 *  - `issuing` — оплачен, карта выпускается;
 *  - `use` — карта готова, остался шаг клиента.
 */
export type PathStage = 'explain' | 'pay' | 'issuing' | 'use';

export type PathStepsInput = {
  stage: PathStage;
  /** Название сервиса («ChatGPT»); null — «подписку». */
  service?: string | null | undefined;
  /** Сумма заказа, уже отформатированная («2 460 ₽»). */
  payText?: string | null | undefined;
  /** Сколько ляжет / лежит на карте («$20»). */
  cardText?: string | null | undefined;
  /** Домен сайта сервиса («chatgpt.com»). */
  siteHost?: string | null | undefined;
  /** Подсказка к шагу 3 на стадии `use` («VPN США · цена в долларах»). */
  useHint?: string | null | undefined;
  /** У клиента уже есть активная карта: долив или новая — решает сервер. */
  topUp?: boolean | undefined;
};

const PAY_HINT = 'здесь, через СБП или российской картой';

function where(siteHost: string | null | undefined): string {
  return siteHost ? `на ${siteHost}` : 'на сайте сервиса';
}

function thirdAhead(input: PathStepsInput): PathStep {
  return {
    n: 3,
    title: `Сам оформляешь ${input.service ?? 'подписку'} этой картой`,
    hint: `${where(input.siteHost)}, в своём аккаунте`,
    state: 'ahead',
  };
}

export function buildPathSteps(input: PathStepsInput): PathStep[] {
  const pay = input.payText ? ` — ${input.payText}` : '';

  switch (input.stage) {
    case 'explain':
      return [
        {
          n: 1,
          title: 'Выбираешь сервис и платишь рублями',
          hint: 'через СБП или российской картой',
          state: 'ahead',
        },
        {
          n: 2,
          title: 'Получаешь виртуальную карту в долларах',
          hint: 'она появится здесь, во вкладке «Карта»',
          state: 'ahead',
        },
        {
          n: 3,
          title: 'Сам оформляешь подписку на сайте сервиса',
          hint: 'и платишь этой картой — аккаунт остаётся твоим',
          state: 'ahead',
        },
      ];
    case 'pay':
      return [
        { n: 1, title: `Оплачиваешь заказ${pay}`, hint: PAY_HINT, state: 'current' },
        {
          n: 2,
          title: `Получаешь виртуальную карту${input.cardText ? ` с ${input.cardText}` : ''}`,
          hint: 'через пару минут — во вкладке «Карта» и в чате',
          state: 'ahead',
        },
        thirdAhead(input),
      ];
    case 'issuing':
      return [
        { n: 1, title: `Заказ оплачен${pay}`, hint: null, state: 'done' },
        {
          n: 2,
          // При уже выпущенной карте сервер сам решает, долить её или
          // выпустить новую (старая могла истекать): текст верен в обоих.
          title: input.topUp ? 'Кладу деньги на карту' : 'Карта выпускается',
          hint: input.cardText ? `на неё ляжет ${input.cardText}` : 'обычно это пара минут',
          state: 'current',
        },
        thirdAhead(input),
      ];
    case 'use':
      return [
        { n: 1, title: 'Заказ оплачен', hint: null, state: 'done' },
        {
          n: 2,
          title: `Карта выпущена${input.cardText ? ` — на ней ${input.cardText}` : ''}`,
          hint: null,
          state: 'done',
        },
        {
          n: 3,
          title: `Оформи ${input.service ?? 'подписку'} ${where(input.siteHost)}`,
          hint: input.useHint ?? null,
          state: 'current',
        },
      ];
  }
}

/** Домен сайта сервиса из ссылки оплаты: без `www.` и пути; мусор — null. */
export function siteHostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./, '') || null;
  } catch {
    // Невалидная ссылка — домен не называем, шаг скажет «на сайте сервиса».
    return null;
  }
}

/**
 * Короткая подсказка к шагу «оформи сервис»: VPN, валюта цены, браузер. Полные
 * правила — в листе «Не получается оплатить?» и в сообщении бота; здесь только
 * то, на чём спотыкаются чаще всего.
 */
export function serviceStepHint(
  instructions: Pick<ServicePaymentInstructions, 'requiresVpn' | 'vpnLocation' | 'requiredCurrency' | 'paymentUrl'> | null | undefined,
): string | null {
  if (!instructions) return null;
  const parts: string[] = [];
  if (instructions.requiresVpn) {
    parts.push(instructions.vpnLocation ? `VPN ${instructions.vpnLocation}` : 'нужен VPN');
  }
  if (instructions.requiredCurrency) {
    parts.push(
      instructions.requiredCurrency === 'USD'
        ? 'цена в долларах'
        : `цена в ${instructions.requiredCurrency}`,
    );
  }
  // «Через браузер» — только когда есть сайт: покупка в мобильном приложении
  // идёт через App Store / Google Play, и наша карта там не нужна.
  if (instructions.paymentUrl) parts.push('через браузер, не приложение');
  return parts.length > 0 ? parts.join(' · ') : null;
}
