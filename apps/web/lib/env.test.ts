import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Гейт «выбран провайдер — обязаны быть его ключи» (ТЗ Freekassa, этап 3).
 *
 * `getServerEnv()` кэширует разбор, поэтому каждый кейс получает СВЕЖИЙ модуль
 * через `vi.resetModules()` + динамический импорт: иначе проверялся бы только
 * первый сценарий.
 */

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  APP_URL: 'https://www.oplatishka.com',
};

async function loadEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FREEKASSA_') || key === 'PAYMENT_PRIMARY_PROVIDER') {
      delete process.env[key];
    }
  }
  Object.assign(process.env, BASE_ENV);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const mod = await import('./env.ts');
  return mod.getServerEnv();
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('PAYMENT_PRIMARY_PROVIDER', () => {
  it('по умолчанию loveandpay — потеря env возвращает контур в проверенное состояние', async () => {
    const env = await loadEnv({});
    expect(env.PAYMENT_PRIMARY_PROVIDER).toBe('loveandpay');
  });

  it('опечатка в значении роняет старт, а не меняет поведение молча', async () => {
    // Ровно ради этого выбран строковый enum вместо булева FREEKASSA_ACTIVE:
    // `FREEKASSA_ACTIVE=True` наивная проверка прочитала бы как «выключено».
    await expect(loadEnv({ PAYMENT_PRIMARY_PROVIDER: 'Freekassa' })).rejects.toThrow(
      /PAYMENT_PRIMARY_PROVIDER/,
    );
    await expect(loadEnv({ PAYMENT_PRIMARY_PROVIDER: 'true' })).rejects.toThrow();
  });

  it('пустая строка трактуется как «не задано» и берёт дефолт', async () => {
    const env = await loadEnv({ PAYMENT_PRIMARY_PROVIDER: '' });
    expect(env.PAYMENT_PRIMARY_PROVIDER).toBe('loveandpay');
  });
});

describe('гейт ключей Freekassa', () => {
  const KEYS = {
    FREEKASSA_API_KEY: 'api-key',
    FREEKASSA_SHOP_ID: '777',
    FREEKASSA_SECRET_WORD_2: 'secret-2',
  };

  it('freekassa без ключей — старт падает с указанием на конкретные переменные', async () => {
    // Сценарий «переключили флаг, забыли ключ» должен ловиться валидацией, а не
    // первым клиентом, получившим 500 на кнопку «Оплатить».
    await expect(loadEnv({ PAYMENT_PRIMARY_PROVIDER: 'freekassa' })).rejects.toThrow(
      /FREEKASSA_API_KEY[\s\S]*FREEKASSA_SHOP_ID[\s\S]*FREEKASSA_SECRET_WORD_2/,
    );
  });

  it('freekassa без ОДНОГО ключа тоже падает', async () => {
    await expect(
      loadEnv({
        PAYMENT_PRIMARY_PROVIDER: 'freekassa',
        ...KEYS,
        FREEKASSA_SECRET_WORD_2: undefined,
      }),
    ).rejects.toThrow(/FREEKASSA_SECRET_WORD_2/);
  });

  it('freekassa с полным набором ключей стартует', async () => {
    const env = await loadEnv({ PAYMENT_PRIMARY_PROVIDER: 'freekassa', ...KEYS });
    expect(env.PAYMENT_PRIMARY_PROVIDER).toBe('freekassa');
    expect(env.FREEKASSA_SHOP_ID).toBe(777);
  });

  it('гейт ОДНОСТОРОННИЙ: loveandpay без платёжных ключей стартует', async () => {
    // Иначе dev-стенд перестал бы подниматься: там платёжных ключей нет
    // намеренно, а флаг не задан и берёт дефолт loveandpay.
    const env = await loadEnv({});
    expect(env.PAYMENT_PRIMARY_PROVIDER).toBe('loveandpay');
    expect(env.LOVEANDPAY_API_KEY).toBeUndefined();
  });
});

describe('дефолты Freekassa', () => {
  it('fallback-IP, способ оплаты и TTL счёта имеют рабочие значения без env', async () => {
    const env = await loadEnv({});
    // 127.0.0.1 провайдер блокирует — дефолт обязан быть публичным IP узла.
    expect(env.FREEKASSA_FALLBACK_IP).toBe('187.124.172.104');
    expect(env.FREEKASSA_METHOD_ID).toBe(44);
    expect(env.FREEKASSA_INVOICE_TTL_HOURS).toBe(1);
    // Тот же порог, что у L&P (решение владельца): переключение шлюза не
    // меняет, какие заказы можно оформить.
    expect(env.FREEKASSA_MIN_AMOUNT_RUB).toBe(500);
  });

  it('невалидный fallback-IP не проходит валидацию', async () => {
    await expect(loadEnv({ FREEKASSA_FALLBACK_IP: 'не-адрес' })).rejects.toThrow(
      /FREEKASSA_FALLBACK_IP/,
    );
  });
});

/**
 * `KEY=` в env читается как «ещё не заполнил», а не как значение (аудит
 * 2026-08-10). До фикса пустая строка обходила дефолты числовых схем:
 * `z.coerce.number()` превращает '' в 0, а `.default()` срабатывает только на
 * `undefined`. Цена ошибки денежная: `COMMISSION_PERCENT=` — работа с нулевой
 * наценкой, `FREEKASSA_MAX_AMOUNT_RUB=` — снятый потолок суммы. Сигнала нет
 * никакого, а правка env через API Dokploy перезаписывает его ЦЕЛИКОМ, то есть
 * опечатка ровно такого вида и вероятна.
 */
describe('пустая строка в env = «не задано»', () => {
  it('РЕГРЕСС: COMMISSION_PERCENT= не обнуляет наценку', async () => {
    const env = await loadEnv({ COMMISSION_PERCENT: '' });
    expect(env.COMMISSION_PERCENT).toBe(10);
  });

  it('РЕГРЕСС: FREEKASSA_MAX_AMOUNT_RUB= не снимает потолок суммы', async () => {
    const env = await loadEnv({ FREEKASSA_MAX_AMOUNT_RUB: '' });
    expect(env.FREEKASSA_MAX_AMOUNT_RUB).toBe(140_000);
  });

  it('дефолты числовых денежных env переживают пустую строку', async () => {
    const env = await loadEnv({
      CARD_ISSUE_FEE_USD_CENTS: '',
      RATE_FALLBACK_USDT_RUB: '',
      LOVEANDPAY_MIN_AMOUNT_RUB: '',
      FREEKASSA_MIN_AMOUNT_RUB: '',
      FREEKASSA_BUYER_FEE_PERCENT: '',
      PAYSPACE_CARD_BUFFER_PERCENT: '',
    });
    expect(env.CARD_ISSUE_FEE_USD_CENTS).toBe(0);
    expect(env.RATE_FALLBACK_USDT_RUB).toBe(81);
    expect(env.LOVEANDPAY_MIN_AMOUNT_RUB).toBe(500);
    expect(env.FREEKASSA_MIN_AMOUNT_RUB).toBe(500);
    expect(env.FREEKASSA_BUYER_FEE_PERCENT).toBe(6);
    expect(env.PAYSPACE_CARD_BUFFER_PERCENT).toBe(0);
  });

  it('пустая строка не ломает enum-переменные с дефолтом', async () => {
    // PAYMENT_PRIMARY_PROVIDER своим тестом покрыт выше — здесь второй enum,
    // у которого неверный дефолт означает обход per-IP лимита (инвариант 9).
    const env = await loadEnv({ CLIENT_IP_MODE: '' });
    expect(env.CLIENT_IP_MODE).toBe('traefik');
  });

  it('заданное значение по-прежнему сильнее дефолта', async () => {
    const env = await loadEnv({ COMMISSION_PERCENT: '30' });
    expect(env.COMMISSION_PERCENT).toBe(30);
  });
});
