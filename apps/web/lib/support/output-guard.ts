/**
 * Выходной фильтр ответа помощника (спека §5, денилист).
 *
 * Промпт — просьба к модели. Гарантия — здесь: запрещённое слово в ответе
 * клиент не увидит, даже если модель его произнесла. Срабатывание → клиенту
 * нейтральная фраза, разговор оператору с триггером `guard`, Sentry.
 *
 * Чистая функция по денилисту, без семантики: проще, чем классификатор, и
 * ошибается ТОЛЬКО в сторону «лишний раз передать человеку».
 */

export type GuardCategory = 'partner' | 'country' | 'pricing' | 'internal';

export type GuardVerdict = { ok: true } | { ok: false; category: GuardCategory; matched: string };

/**
 * Категории по порядку проверки.
 *
 *   - `partner` — имена компаний, через которые идут платежи и выпуск карт;
 *   - `country` — страна выпуска карты: страна РЯДОМ со словом «карта»
 *     (в пределах короткого окна). Страна сама по себе разрешена — сервис
 *     может быть американским, а VPN-локация из инструкции называется
 *     явно (спека §5);
 *   - `pricing` — процент, курс, формула. Суммы в рублях разрешены: это
 *     то, что клиент и так видит на экране заказа;
 *   - `internal` — идентификаторы статусов, устройство систем, какая модель
 *     отвечает.
 */
const DENYLIST: readonly { category: GuardCategory; patterns: readonly RegExp[] }[] = [
  {
    category: 'partner',
    patterns: [/pay\.?space/i, /free\s?kassa/i, /love\s?(?:&|and)\s?pay/i, /rapira/i],
  },
  {
    category: 'country',
    // Страна в окне ±40 символов от «карт». Окно, а не одно предложение:
    // «Карта у вас, кстати, американская» — тоже утечка.
    patterns: [
      /карт[а-яё]*.{0,40}?(?:американск|сша|\bus\b|европейск|великобритани|британск|литовск|эстонск|латвийск|казахск|киргизск|армянск|грузинск)/i,
      /(?:американск|сша|\bus\b|европейск|великобритани|британск|литовск|эстонск|латвийск|казахск|киргизск|армянск|грузинск).{0,40}?карт/i,
    ],
  },
  {
    category: 'pricing',
    patterns: [
      /\d+\s?%/,
      /\d+\s?процент/i,
      /комисси[яию]\s+(?:составляет|равна|\d)/i,
      // ⚠️ Без `\b`: в JS граница слова кириллицу не видит («Курс» не
      // совпадал), а «курс» как подстрока других слов («экскурсия»,
      // «конкурс») в ответах поддержки не встречается.
      /курс/i,
      /usdt/i,
      /формул/i,
    ],
  },
  {
    category: 'internal',
    patterns: [
      // Идентификаторы статусов и полей: snake_case из двух и более слов.
      /\b[a-z]+(?:_[a-z]+)+\b/,
      /deepseek/i,
      /anthropic/i,
      /\bclaude\b/i,
      /\bgpt/i,
      /\bvps\b/i,
      /postgres/i,
      /\bredis\b/i,
      /dokploy/i,
    ],
  },
];

/** Что из snake_case НЕ считать идентификатором: пользовательские обороты. */
const SNAKE_CASE_ALLOW = new Set(['e_mail']);

export function guardModelOutput(text: string): GuardVerdict {
  if (!text) return { ok: true };
  for (const { category, patterns } of DENYLIST) {
    for (const pattern of patterns) {
      const m = pattern.exec(text);
      if (!m) continue;
      if (category === 'internal' && SNAKE_CASE_ALLOW.has(m[0].toLowerCase())) continue;
      return { ok: false, category, matched: m[0] };
    }
  }
  return { ok: true };
}
