import type Anthropic from '@anthropic-ai/sdk';
import {
  getMyOrdersInput,
  getServiceInstructionsInput,
  searchCatalogInput,
  supportRequestHumanInput,
} from '@oplati/types';
import type { ZodError, ZodType, ZodTypeDef } from 'zod';

import type { CatalogItem } from './index.ts';
import type { ToolExecution } from './run.ts';

/**
 * Инструменты помощника поддержки (спека §6). ТОЛЬКО чтение.
 *
 * Ни отмены, ни повторной ссылки, ни повторной выдачи реквизитов карты — это
 * в приложении или у оператора. Третьего канала выдачи PAN не будет: у карты
 * ровно два санкционированных канала (сообщение при выпуске и разовый показ в
 * кабинете), и tool «покажи реквизиты» был бы третьим без threat-model.
 *
 * Результаты — в КЛИЕНТСКИХ формулировках (спека §5): модель физически не
 * видит `payment_review` и подобного, ей нечего проговориться.
 */

/** Заказ так, как о нём можно говорить с клиентом. */
export interface SupportOrderView {
  /** Номер вида `ORD-7KX42` — им клиент и оперирует. */
  number: string;
  service: string;
  /** Уже отформатированная сумма, например «1 190 ₽». */
  amount: string | null;
  /** Статус СЛОВАМИ из словаря кабинета, никогда не идентификатор. */
  status: string;
  /** До какого времени живёт счёт / фиксация цены, словами. `null` — не применимо. */
  validUntil: string | null;
  /** Карта — только маска `**** 1234`. */
  card: string | null;
  createdAt: string;
}

export interface SupportServiceInstructions {
  service: string;
  requiresVpn: boolean;
  vpnLocation: string | null;
  currency: string | null;
  billing: string | null;
  notes: string | null;
}

export interface SupportToolHandlers {
  get_my_orders: (input: Record<string, never>) => Promise<SupportOrderView[]>;
  get_service_instructions: (input: {
    query: string;
  }) => Promise<SupportServiceInstructions | { notFound: true; query: string }>;
  search_catalog: (input: { query: string }) => Promise<CatalogItem[]>;
  request_human: (input: { reason: string }) => Promise<{ acknowledged: true }>;
}

export const supportTools: Anthropic.Tool[] = [
  {
    name: 'get_my_orders',
    description:
      'Последние заказы ТЕКУЩЕГО клиента: номер, сервис, сумма, статус словами, до какого времени действует счёт, маска карты. Вызывай, когда клиент спрашивает о статусе заказа, оплаты или карты. Без этого инструмента ты состояния заказа не знаешь.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_service_instructions',
    description:
      'Инструкция оплаты на сайте конкретного сервиса: нужен ли VPN и какая локация, в какой валюте платить, что вводить в billing, особенности. Вызывай, когда карта не проходит на сайте сервиса или клиент спрашивает, как оплатить именно этот сервис.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Название сервиса, как его назвал клиент (например «spotify», «netflix», «chatgpt»).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_catalog',
    description:
      'Есть ли сервис в каталоге Оплатишки. Вызывай, когда клиент спрашивает, можно ли оплатить какой-то сервис. Цен в каталоге НЕТ — сумму называет только приложение.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Название сервиса или ключевое слово.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'request_human',
    description:
      'Передать разговор оператору. Вызывай, когда ответа нет в базе знаний, вопрос про деньги назад, документы, претензию, или клиент просит человека. После вызова больше ничего не пиши — клиенту уже сказано, что оператор ответит.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Одна-две фразы для оператора: с чем пришёл клиент и почему нужен человек.',
        },
      },
      required: ['reason'],
    },
  },
];

const INPUT_SCHEMAS = {
  get_my_orders: getMyOrdersInput,
  get_service_instructions: getServiceInstructionsInput,
  search_catalog: searchCatalogInput,
  request_human: supportRequestHumanInput,
} satisfies {
  [K in keyof SupportToolHandlers]: ZodType<Parameters<SupportToolHandlers[K]>[0], ZodTypeDef, unknown>;
};

function isSupportTool(name: string): name is keyof SupportToolHandlers {
  return Object.hasOwn(INPUT_SCHEMAS, name);
}

function invalidInput(error: ZodError): ToolExecution {
  return { result: { error: `invalid tool input: ${error.message}` }, isError: true };
}

/**
 * Диспетчер tools поддержки — Zod-граница ДО обработчика, экзостивный switch:
 * новый tool без ветки не соберётся.
 */
export async function dispatchSupportTool(
  handlers: SupportToolHandlers,
  name: string,
  rawInput: unknown,
): Promise<ToolExecution> {
  if (!isSupportTool(name)) {
    return { result: { error: `unknown tool: ${name}` }, isError: true };
  }
  switch (name) {
    case 'get_my_orders': {
      const parsed = INPUT_SCHEMAS.get_my_orders.safeParse(rawInput ?? {});
      if (!parsed.success) return invalidInput(parsed.error);
      return { result: await handlers.get_my_orders(parsed.data), isError: false };
    }
    case 'get_service_instructions': {
      const parsed = INPUT_SCHEMAS.get_service_instructions.safeParse(rawInput);
      if (!parsed.success) return invalidInput(parsed.error);
      return { result: await handlers.get_service_instructions(parsed.data), isError: false };
    }
    case 'search_catalog': {
      const parsed = INPUT_SCHEMAS.search_catalog.safeParse(rawInput);
      if (!parsed.success) return invalidInput(parsed.error);
      return { result: await handlers.search_catalog(parsed.data), isError: false };
    }
    case 'request_human': {
      const parsed = INPUT_SCHEMAS.request_human.safeParse(rawInput);
      if (!parsed.success) return invalidInput(parsed.error);
      return { result: await handlers.request_human(parsed.data), isError: false };
    }
    default: {
      const unreachable: never = name;
      throw new Error(`unhandled support tool: ${String(unreachable)}`);
    }
  }
}
