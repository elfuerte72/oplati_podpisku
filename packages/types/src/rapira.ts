import { z } from 'zod';

/** Минимальный подтверждённый контракт строки `GET /open/market/rates`. */
export const rapiraMarketRateSchema = z
  .object({
    symbol: z.string(),
    askPrice: z.number().positive(),
    baseCurrency: z.string(),
    quoteCurrency: z.string(),
  })
  .passthrough();
export type RapiraMarketRate = z.infer<typeof rapiraMarketRateSchema>;

/** Конверт публичного эндпоинта Rapira; строки рынка валидируются отдельно. */
export const rapiraMarketRatesResponseSchema = z.object({
  // Эндпоинт отдаёт все пары. Каждую строку проверяет отдельная схема ниже по
  // потоку, чтобы дрейф постороннего рынка не ломал валидный USDT/RUB.
  data: z.array(z.unknown()),
  code: z.number().int(),
  isWorking: z.number().int(),
});
export type RapiraMarketRatesResponse = z.infer<typeof rapiraMarketRatesResponseSchema>;
