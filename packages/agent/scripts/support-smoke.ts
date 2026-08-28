/**
 * Смоук помощника поддержки против ЖИВОГО DeepSeek.
 *
 * Зачем он есть: дока провайдера молчит о том, что нам важнее всего —
 * какие значения `stop_reason` он возвращает, какой формы `usage`, как
 * отчитывается о кэше, переваривает ли `system` строкой и работает ли
 * TypeScript SDK через `baseURL` (в доке только Python). Гадать об этом в
 * коде — тот же грех, что выдумывать контракт внешнего API.
 *
 * ⚠️ В CI не ставить: ходит в живой endpoint и стоит денег (копейки).
 *
 * Запуск (ключ — из окружения, в репозиторий не попадает):
 *   SUPPORT_AI_API_KEY=... pnpm --filter @oplati/agent smoke:support
 */

import {
  getSupportClient,
  supportModel,
  SUPPORT_AI_DEFAULT_BASE_URL,
} from '../src/client.ts';
import { runProfile, type AgentProfile } from '../src/run.ts';

const ORDERS_TOOL = {
  name: 'get_my_orders',
  description: 'Последние заказы текущего клиента. Вызывай, когда спрашивают о статусе заказа или оплаты.',
  input_schema: { type: 'object' as const, properties: {} },
};

/** Фиксированный ответ tool'а: смоук снимает форму ответа, а не работу БД. */
const FAKE_ORDERS = [
  {
    service: 'Spotify Premium, 1 месяц',
    amount: '1 190 ₽',
    status: 'Оплачен, готовим карту',
    validUntil: '28 августа, 14:00',
  },
];

function buildSmokeProfile(): AgentProfile {
  return {
    client: getSupportClient(),
    model: supportModel(),
    temperature: 0.2,
    maxTokens: 600,
    thinking: { type: 'disabled' },
    system:
      'Вы помощник поддержки Оплатишки. Отвечаете на «вы», по делу, без выдумок. ' +
      'О статусе заказа отвечаете ТОЛЬКО по результату инструмента get_my_orders.',
    tools: [ORDERS_TOOL],
    maxIterations: 4,
    historyCaching: false,
    toolErrorsAsIsError: false,
    maxWebSearchPerRun: 0,
    metadataUserId: 'smoke-hash',
    dispatch: async (name) => {
      if (name !== 'get_my_orders') {
        return { result: { error: `unknown tool: ${name}` }, isError: true };
      }
      return { result: FAKE_ORDERS, isError: false };
    },
    texts: {
      truncatedNote: '\n\n(Ответ оборвался.)',
      truncatedEmpty: 'Ответ не поместился.',
      noAnswer: 'Не получилось составить ответ.',
    },
  };
}

/**
 * Сырой одиночный вызов — печатает ответ провайдера целиком, ДО того как его
 * причешет цикл. Именно тут видно `model`, `stop_reason` и полную форму `usage`.
 */
async function rawProbe(): Promise<void> {
  const requested = supportModel();
  const started = Date.now();
  const response = await getSupportClient().messages.create({
    model: requested,
    max_tokens: 200,
    temperature: 0.2,
    thinking: { type: 'disabled' },
    system: 'Вы помощник поддержки. Отвечайте на «вы», одним предложением.',
    messages: [{ role: 'user', content: 'Здравствуйте, вы работаете?' }],
    metadata: { user_id: 'smoke-hash' },
  });

  console.log('--- сырой вызов ---');
  console.log('запрошенная модель :', requested);
  // ⚠️ Незнакомый id DeepSeek молча маппит на flash: расхождение здесь означает,
  // что в env опечатка, а выглядит она как рабочая настройка.
  console.log('модель в ответе    :', response.model);
  console.log('совпало            :', response.model === requested ? 'да' : 'НЕТ — проверьте SUPPORT_AI_MODEL');
  console.log('stop_reason        :', response.stop_reason);
  console.log('usage              :', JSON.stringify(response.usage, null, 2));
  console.log('время ответа, мс   :', Date.now() - started);
  console.log('текст              :', JSON.stringify(response.content));
}

/** Полный ход через профиль: system → tool_use → tool_result → финальный текст. */
async function toolLoopProbe(): Promise<void> {
  const started = Date.now();
  const result = await runProfile(
    [{ role: 'user', content: 'Здравствуйте! Что с моим заказом на Spotify?' }],
    buildSmokeProfile(),
  );

  console.log('\n--- ход через профиль (с tool) ---');
  console.log('tools вызвано      :', result.toolCalls.map((c) => c.name).join(', ') || '(ни одного)');
  console.log('ход неполный       :', result.incomplete);
  console.log('usage              :', JSON.stringify(result.usage, null, 2));
  console.log('время ответа, мс   :', Date.now() - started);
  console.log('ответ клиенту      :\n' + result.text);
}

async function main(): Promise<void> {
  if (!process.env.SUPPORT_AI_API_KEY) {
    console.error('SUPPORT_AI_API_KEY не задан — смоук ходит в живой endpoint и без ключа бессмыслен.');
    process.exit(1);
  }
  console.log('baseURL            :', process.env.SUPPORT_AI_BASE_URL || SUPPORT_AI_DEFAULT_BASE_URL);
  await rawProbe();
  await toolLoopProbe();
}

await main();
