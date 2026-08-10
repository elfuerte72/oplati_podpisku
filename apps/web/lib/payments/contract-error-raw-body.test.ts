import { describe, expect, it } from 'vitest';

import { FreekassaContractError } from '../freekassa/errors.ts';
import { LoveAndPayContractError } from '../loveandpay/errors.ts';

/**
 * Сырое тело ответа платёжного шлюза при дрейфе контракта может содержать
 * реквизиты плательщика, а ошибки сериализуются в pino и Sentry обходом
 * СОБСТВЕННЫХ полей объекта. Поэтому `rawBody` — неперечисляемое свойство (тот
 * же приём, что у `PaySpaceContractError`; аудит 2026-08-10).
 */
describe('rawBody контракт-ошибок не попадает в сериализацию', () => {
  const PAN_BODY = '{"pan":"4111111111111111","cvc":"123"}';

  for (const [name, make] of [
    ['Freekassa', () => new FreekassaContractError(200, 'drift', PAN_BODY)],
    ['Love&Pay', () => new LoveAndPayContractError(200, 'drift', PAN_BODY)],
  ] as const) {
    it(`${name}: rawBody не перечисляется и не сериализуется`, () => {
      const err = make();

      expect(Object.keys(err)).not.toContain('rawBody');
      expect(JSON.stringify({ ...err })).not.toContain('4111111111111111');
      // Для отладки поле по-прежнему доступно напрямую.
      expect(err.rawBody).toBe(PAN_BODY);
      // Остальные поля видны как раньше.
      expect(Object.keys(err)).toContain('httpStatus');
    });
  }
});
