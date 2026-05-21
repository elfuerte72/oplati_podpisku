import type Anthropic from '@anthropic-ai/sdk';

/**
 * Описания AI tools под MVP (Love & Pay + app.pay.space).
 * Реализация — `apps/web/lib/tool-handlers/`.
 *
 * Контракт строго совпадает с интерфейсом `ToolHandlers` ниже в `./index.ts`.
 */
export const tools: Anthropic.Tool[] = [
  {
    name: 'search_catalog',
    description:
      'Найти AI-сервисы в каталоге по названию. Возвращает массив сервисов с базовой ценой в USD-центах. Используй ВСЕГДА перед тем как называть цену — никогда не придумывай цены сам.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Название сервиса или ключевое слово (claude, chatgpt, perplexity, mistral, copilot, cursor, midjourney).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'propose_order',
    description:
      'Сформировать черновик заказа и рассчитать итоговую сумму в рублях с учётом текущего курса USDT→RUB и комиссии 10%. Возвращает orderId, shortId, разбивку (subtotal, commission, total), expiresAt и флаг isCustom. Передай ровно одно из: serviceId (для сервисов из search_catalog) ИЛИ customDescription (для сервисов вне каталога). После создания заказа спроси у пользователя подтверждение.',
    input_schema: {
      type: 'object',
      properties: {
        serviceId: {
          type: 'string',
          description:
            'UUID сервиса из search_catalog. Указывай ТОЛЬКО если сервис найден в каталоге. Взаимоисключающее с customDescription.',
        },
        customDescription: {
          type: 'string',
          maxLength: 500,
          description:
            'Свободное описание сервиса для заказов вне каталога. Формат: "Название Тариф, период". Примеры: "iCloud+ 200GB, 1 месяц", "Patreon Creator Pro, 12 месяцев". Используй ТОЛЬКО если search_catalog не нашёл подходящего сервиса. Взаимоисключающее с serviceId.',
        },
        serviceName: {
          type: 'string',
          maxLength: 100,
          description:
            'Человекочитаемое короткое название сервиса (без тарифа и срока). Примеры: "iCloud+", "Patreon Creator". Используй ВМЕСТЕ с customDescription для удобного отображения оператору. Игнорируется, если задан serviceId.',
        },
        amountUsdCents: {
          type: 'number',
          description:
            'Сумма заказа в USD-центах за весь срок (например 2000 = 20.00 USD). Для каталога: basePriceUsdCents из search_catalog × количество месяцев. Для custom: ровно та сумма, которую назвал пользователь.',
        },
        paymentMethod: {
          type: 'string',
          enum: ['sbp', 'card'],
          description: 'Предпочитаемый способ оплаты (если не задано — провайдер выбирает).',
        },
      },
      required: ['amountUsdCents'],
    },
  },
  {
    name: 'confirm_order',
    description:
      'Подтвердить заказ после ЯВНОГО согласия пользователя. Создаёт счёт в Love & Pay и возвращает paymentUrl, qrPayload и expiresAt. Передай пользователю paymentUrl ссылкой; QR — текстом «отсканируй СБП-плательщиком» (только если qrPayload задан).',
    input_schema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'UUID заказа, полученный от propose_order.',
        },
        paymentMethod: {
          type: 'string',
          enum: ['sbp', 'card'],
          description: 'Способ оплаты (опционально; если не задан — провайдер сам выберет).',
        },
      },
      required: ['orderId'],
    },
  },
  {
    name: 'request_human',
    description:
      'Передать разговор оператору. Вызывай когда пользователь явно просит человека, либо ситуация выходит за рамки твоих возможностей (платёжный спор, нестандартный KYC-кейс).',
    input_schema: {
      type: 'object',
      properties: {
        orderId: {
          type: ['string', 'null'],
          description: 'UUID заказа, если разговор привязан к заказу; иначе null.',
        },
        reason: {
          type: 'string',
          description: 'Краткая причина (2-3 предложения) для оператора.',
        },
      },
      required: ['reason'],
    },
  },
];
