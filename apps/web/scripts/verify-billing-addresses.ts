/**
 * Проверка, что адреса пула `BILLING_ADDRESS_POOL` существуют на самом деле.
 *
 * Два независимых источника, оба публичные и без ключа:
 *  - геокодер Бюро переписи США — попадает ли номер дома в реальный диапазон
 *    улицы и какой у этого отрезка канонический ZIP;
 *  - OpenStreetMap Nominatim — стоит ли по адресу объект (здание, организация).
 *
 * Запуск — перед добавлением адреса в пул и время от времени после:
 *
 *   pnpm --filter web exec tsx scripts/verify-billing-addresses.ts
 *   pnpm --filter web exec tsx scripts/verify-billing-addresses.ts "201 W 36th Ave|Anchorage|AK|99503"
 *
 * Аргументы — кандидаты в форме `улица|город|штат|ZIP`; без аргументов
 * проверяется сам пул. Код выхода 1, если хоть один адрес не подтверждён.
 *
 * ⚠️ В тесты не входит намеренно: это сеть, а Nominatim просит не чаще запроса
 * в секунду. Правила, которые ломаются опечаткой (ZIP чужого штата), держит
 * `lib/billing-address.test.ts` без сети.
 */
import { BILLING_ADDRESS_POOL } from '../lib/billing-address';

type Candidate = { street: string; city: string; stateCode: string; zip: string };

const REQUEST_TIMEOUT_MS = 20_000;
/** Nominatim: не чаще одного запроса в секунду (правила сервиса). */
const NOMINATIM_PAUSE_MS = 1_200;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Таймер снимается ПОСЛЕ чтения тела: сервер, отдавший заголовки и
    // замолчавший, иначе вешал бы скрипт навсегда.
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Поле чужого JSON без схемы. Приведение типа стоит ПОСЛЕ проверки `key in
 * value`: у ключа-строки TypeScript сам объект не сужает, а Zod-схема на два
 * сторонних ответа ради разового скрипта была бы длиннее самого скрипта.
 */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Канонический ZIP по переписи или `null`, если адрес не найден. */
async function censusZip(c: Candidate): Promise<string | null> {
  const line = `${c.street}, ${c.city}, ${c.stateCode} ${c.zip}`;
  const data = await getJson(
    'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=' +
      encodeURIComponent(line),
  );
  const matches = field(field(data, 'result'), 'addressMatches');
  const first = Array.isArray(matches) ? matches[0] : undefined;
  const zip = field(field(first, 'addressComponents'), 'zip');
  return typeof zip === 'string' ? zip : null;
}

/** Что стоит по адресу в OpenStreetMap, или `null`. */
async function osmObject(c: Candidate): Promise<{ label: string; houseNumber: string | null } | null> {
  const data = await getJson(
    'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&countrycodes=us&q=' +
      encodeURIComponent(`${c.street}, ${c.city}, ${c.stateCode} ${c.zip}, USA`),
    { 'User-Agent': 'oplatishka-address-check/1.0' },
  );
  const hit = Array.isArray(data) ? data[0] : undefined;
  if (!hit) return null;
  const name = field(hit, 'name');
  const houseNumber = field(field(hit, 'address'), 'house_number');
  return {
    label: `${typeof name === 'string' && name ? `«${name}» ` : ''}${String(field(hit, 'category'))}/${String(field(hit, 'type'))}`,
    houseNumber: typeof houseNumber === 'string' ? houseNumber : null,
  };
}

function parseCandidate(arg: string): Candidate {
  const [street, city, stateCode, zip] = arg.split('|').map((part) => part.trim());
  if (!street || !city || !stateCode || !zip) {
    throw new Error(`ожидалось "улица|город|штат|ZIP", получено: ${arg}`);
  }
  return { street, city, stateCode, zip };
}

const args = process.argv.slice(2);
const candidates: Candidate[] =
  args.length > 0
    ? args.map(parseCandidate)
    : BILLING_ADDRESS_POOL.map((a) => ({
        street: a.streetLine1,
        city: a.city,
        stateCode: a.stateCode,
        zip: a.postalCode,
      }));

let failed = 0;
for (const candidate of candidates) {
  const line = `${candidate.street}, ${candidate.city}, ${candidate.stateCode} ${candidate.zip}`;
  try {
    const zip = await censusZip(candidate);
    const osm = await osmObject(candidate);
    const houseNumber = candidate.street.split(' ')[0] ?? '';

    const problems: string[] = [];
    if (zip === null) problems.push('перепись адрес не нашла');
    else if (zip !== candidate.zip) problems.push(`по переписи ZIP ${zip}, а не ${candidate.zip}`);
    if (osm === null) problems.push('в OpenStreetMap объекта нет');
    else if (osm.houseNumber !== houseNumber) problems.push(`в OpenStreetMap номер дома ${osm.houseNumber ?? '—'}`);

    if (problems.length > 0) failed++;
    process.stdout.write(
      `${problems.length === 0 ? 'OK  ' : 'FAIL'} ${line}\n     ${osm?.label ?? '—'}${problems.length ? `\n     ${problems.join('; ')}` : ''}\n`,
    );
  } catch (err) {
    failed++;
    process.stdout.write(`FAIL ${line}\n     источник не ответил: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  await sleep(NOMINATIM_PAUSE_MS);
}

process.stdout.write(`\nПодтверждено ${candidates.length - failed} из ${candidates.length}\n`);
process.exit(failed === 0 ? 0 : 1);
