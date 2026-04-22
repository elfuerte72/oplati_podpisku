import type Anthropic from '@anthropic-ai/sdk';

/**
 * Описания инструментов в формате Anthropic Tool Use.
 * Реализация — в apps/web, где есть доступ к БД и сервисам.
 */
export const tools: Anthropic.Tool[] = [
  {
    name: 'search_catalog',
    description:
      'Найти сервисы в каталоге по названию или категории. Возвращает сервисы с тарифами и ценами в рублях. Используй ВСЕГДА перед тем как называть цену — никогда не придумывай цены сам.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Название сервиса или ключевое слово, напр. "claude", "netflix", "stream"',
        },
        category: {
          type: 'string',
          enum: ['ai', 'streaming', 'travel', 'productivity', 'other'],
          description: 'Категория сервиса (опционально)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'propose_order',
    description:
      'Сформировать черновик заказа и показать пользователю на подтверждение. Вызывай когда все детали известны: сервис, тариф/период, email аккаунта (если нужен).',
    input_schema: {
      type: 'object',
      properties: {
        serviceSlug: {
          type: 'string',
          description: 'slug сервиса из каталога, например "claude-pro"',
        },
        customDescription: {
          type: 'string',
          description: 'Свободное описание, если сервиса нет в каталоге',
        },
        tierName: { type: 'string', description: 'Название тарифа' },
        period: { type: 'string', enum: ['month', 'year'] },
        accountEmail: {
          type: 'string',
          description: 'Email клиента на стороне иностранного сервиса',
        },
        notes: {
          type: 'string',
          description: 'Особые пожелания или доп.параметры',
        },
      },
    },
  },
  {
    name: 'confirm_order',
    description:
      'Подтвердить заказ после явного согласия пользователя. Создаёт платёжную ссылку.',
    input_schema: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'ID черновика заказа из propose_order' },
        paymentMethod: {
          type: 'string',
          enum: ['yookassa', 'sbp', 'cryptobot'],
          description: 'Предпочитаемый способ оплаты',
        },
      },
      required: ['orderId', 'paymentMethod'],
    },
  },
  {
    name: 'request_human',
    description:
      'Передать разговор оператору. Вызывай когда пользователь просит, или задача сложнее твоих возможностей (спорные кейсы, KYC, возвраты, проблемы с оплатой).',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: ['user_requested', 'ai_uncertain', 'kyc_complex', 'payment_issue', 'dispute', 'other'],
        },
        context: {
          type: 'string',
          description: 'Краткое summary ситуации для оператора (2-3 предложения)',
        },
      },
      required: ['reason', 'context'],
    },
  },
];
