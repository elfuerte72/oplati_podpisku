import type Anthropic from '@anthropic-ai/sdk';

/**
 * Описания AI tools под MVP.
 *
 * Состав:
 *   - `web_search` — server-side tool Anthropic (выполняется на инфраструктуре
 *     Anthropic, мы handler не пишем). Используется AI чтобы достать актуальную
 *     цену сервиса перед `propose_order`. Без него модель оперирует только
 *     тренировочными данными — там цены могут быть устаревшими.
 *   - `search_catalog`, `propose_order`, `confirm_order`, `request_human` —
 *     наши tools, реализация в `apps/web/lib/tool-handlers/`.
 *
 * Контракт строго совпадает с интерфейсом `ToolHandlers` ниже в `./index.ts`.
 */
export const tools: Anthropic.ToolUnion[] = [
  {
    type: 'web_search_20250305',
    name: 'web_search',
    // Лимит на один agent-вызов: 2 поиска должно хватить (1 на цену основного
    // сервиса, 1 запас на уточнение тарифа). Защита от runaway-стоимости.
    max_uses: 2,
  },
  {
    name: 'search_catalog',
    description:
      'Найти сервис в нашем реестре по названию. Возвращает массив активных сервисов с slug, name, requiresKyc. **Цен в каталоге НЕТ** — используй web_search для актуальной цены. Если сервис нашёлся — пользуйся его serviceId/slug при propose_order; если не нашёлся — этот сервис тоже принимаем, идёшь через customDescription.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Название сервиса или ключевое слово (например "claude", "chatgpt", "spotify", "netflix", "airbnb", "icloud", "notion", "figma", "patreon").',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'propose_order',
    description:
      'Сформировать черновик заказа и рассчитать итоговую сумму в рублях с учётом текущего курса USDT→RUB и комиссии 10%. Возвращает orderId, shortId, разбивку (subtotal, commission, total), expiresAt и флаг isCustom. Передай ровно одно из: serviceId (для сервисов из search_catalog) ИЛИ customDescription (для сервисов вне каталога). amountUsdCents бери ТОЛЬКО из результатов web_search (актуальная цена с официального сайта) — каталог цен не содержит. После создания заказа спроси у пользователя подтверждение.',
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
            'Сумма заказа в USD-центах за весь срок (например 2000 = 20.00 USD). ОБЯЗАТЕЛЬНО получи актуальную цену через web_search на официальном сайте сервиса, затем умножь на количество месяцев. НЕ используй цены из памяти модели — они могут быть устаревшими.',
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
