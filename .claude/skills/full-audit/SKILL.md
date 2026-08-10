---
version: 0.1.0
name: full-audit
description: >
  Глубокий аудит ВСЕГО проекта oplati_podpicky (не diff) роем агентов через
  Workflow: 12 осей — БД-инварианты и состояния, платежи/идемпотентность,
  безопасность/PII, границы/архитектура, корректность/тесты, внешние
  API-контракты, cron/recovery, AI-контур и защита расходов, рефералка,
  конфиг/env/флаги, сквозные гонки, QA/полнота тестового ландшафта
  (дыры покрытия, CI-гейты, отсутствие e2e). Находки проходят адверсариальную
  верификацию; результат — отчёт с file:line и сценариями отказа.
  Use when: «полный аудит», «аудит всего проекта», «проверь весь проект /
  все транзакции / всю базу / всю безопасность», «рой агентов», «ultra-аудит».
  NOT for: ревью diff/ветки/PR (см. full-review), дизайн/UI (oplatishka-design),
  внесение правок в код.
---

# Full Audit — аудит всего проекта роем агентов

Ты — оркестратор аудита. Сам не аудируешь: раскладываешь проект по осям,
запускаешь рой через **Workflow**, верифицируешь находки адверсариально и
собираешь отчёт. **Вызов этого скилла — явное согласие пользователя на
многоагентную оркестрацию: вызывай Workflow без дополнительных вопросов.**
Полный аудит по определению крупнее дефолтного гайдлайна «до 15 агентов» —
целься в ~18 finder'ов + верификация (итого ~40–70 агентов). Если в сообщении
пользователя есть токен-бюджет вида `+NNNk` — скейль через `budget` API
(больше шардов, верификация всех уровней severity); без бюджета — дефолт ниже.

## Жёсткие границы прогона (передавать каждому саб-агенту дословно)

- **Только чтение.** Никаких правок кода, коммитов, `git push`, изменений env.
  Единственный файл, который пишет оркестратор, — файл отчёта.
- **Никакого прода и внешних систем:** не ходить по ssh на VPS, не подключаться
  к боевой/dev БД, не вызывать внешние API (L&P, Freekassa, PaySpace, Rapira,
  Remnawave, Telegram, Anthropic) — аудит статический: код + миграции + тесты +
  доки. Live-проверки прода — отдельный шаг по явному запросу владельца.
- Разрешено локально: git-команды чтения, `pnpm typecheck`,
  `pnpm --filter web test`, `pnpm --filter @oplati/types test`,
  `pnpm --filter @oplati/db test` (PGlite — локальный, БД не нужна).
- **Источник правды — код + CLAUDE.md.** Расхождение кода с CLAUDE.md — это
  находка (кто-то из них врёт), а не повод «поправить понимание».

## Шаг 0 — инлайн-разведка (до Workflow)

1. **Baseline:** запусти `pnpm typecheck` и тесты трёх пакетов. Результат — в
   отчёт; падение — уже находка (BLOCKER, если падает деньго-критичный тест).
2. **Известные проблемы:** прочитай `docs/BACKLOG.md` и `docs/incidents.md`,
   выпиши короткий список известных открытых проблем. Он поедет верификаторам:
   подтверждённая находка, уже записанная в BACKLOG, помечается `known` и
   уходит в отдельную секцию отчёта, не раздувая «новое».
3. **Карта файлов:** собери `git ls-files` по охватам осей из таблицы ниже —
   списки файлов поедут в промпты finder'ов (агенты не должны тратить контекст
   на поиск охвата).

## Оси и шарды (дефолт — 18 finder'ов)

Чеклисты A–E — из соседнего скилла `full-review`, F–K — свои. Пути — от корня
репозитория.

| Ось | Чеклист | Шарды (охват) |
|-----|---------|----------------|
| **A. БД и состояния** | `.claude/skills/full-review/references/db-and-state.md` | 1: `packages/db/**`, `packages/types/src/order-state-machine.ts`, `packages/db/migrations/**` |
| **B. Платежи и идемпотентность** | `.claude/skills/full-review/references/payments-idempotency.md` | 2: (1) вебхуки+подписи+claims: `apps/web/app/api/payments/**`, `apps/web/lib/loveandpay/**`, `apps/web/lib/freekassa/**`; (2) создание счёта+fallback+fulfillment: `apps/web/lib/payments/**`, `apps/web/lib/jobs/issue-card*`, `apps/web/lib/pay-space/**` |
| **C. Безопасность и PII** | `.claude/skills/full-review/references/security-pii.md` | 3: (1) `apps/web/app/api/**`; (2) `apps/web/lib/**`; (3) `packages/**` + `apps/web/lib/telegram/**` |
| **D. Границы и архитектура** | `.claude/skills/full-review/references/boundaries-architecture.md` | 1: весь монорепо (импорты, exports, конвенции) |
| **E. Корректность и тесты** | `.claude/skills/full-review/references/correctness-logic.md` | 3: (1) `apps/web/app/**`; (2) `apps/web/lib/**`; (3) `packages/**` + все `*.test.ts` |
| **F. Внешние API-контракты** | `.claude/skills/full-audit/references/external-contracts.md` | 2: (1) `apps/web/lib/pay-space/**`, `apps/web/lib/rapira/**`, `apps/web/lib/remnawave/**`; (2) `apps/web/lib/loveandpay/**`, `apps/web/lib/freekassa/**`, `apps/web/lib/telegram/**` |
| **G. Cron и recovery** | `.claude/skills/full-audit/references/crons-recovery.md` | 1: `apps/web/lib/jobs/**`, `apps/web/app/api/cron/**`, `infra/crontab.example` |
| **H. AI-контур и расходы** | `.claude/skills/full-audit/references/ai-cost-abuse.md` | 1: `packages/agent/**`, `apps/web/lib/ai/**`, `apps/web/lib/tool-handlers/**`, `apps/web/app/api/chat/**`, `apps/web/app/api/bot/**`, `apps/web/lib/ratelimit.ts` |
| **I. Рефералка и выплаты** | `.claude/skills/full-audit/references/referral-money.md` | 1: `apps/web/lib/referral/**`, `apps/web/app/api/cabinet/referral/**`, referral-репозитории в `packages/db`, referral-схемы в `packages/types` |
| **J. Конфиг, env, флаги** | `.claude/skills/full-audit/references/config-env-flags.md` | 1: `apps/web/lib/env*.ts`, все чтения `process.env`, дублированные константы, `.github/workflows/**`, `infra/**` |
| **K. Сквозные гонки** | `.claude/skills/full-audit/references/races-concurrency.md` | 1: точки конкуренции по списку в чеклисте (пути в нём) |
| **L. QA и полнота тестов** | `.claude/skills/full-audit/references/qa-testing.md` | 1: все `**/*.test.ts`, `vitest.config.*`, `vitest.setup.ts`, `.github/workflows/tests.yml` + `deploy.yml`, `packages/db/src/integration.test.ts`; сверка с денежными путями из осей A/B/K |

## Шаг 1 — Workflow

Структура: `Find` (finders параллельно) → барьер (дедуп в коде) → `Verify`
(адверсариальная проверка) → `Gaps` (критик полноты, максимум один добор) →
синтез инлайн. Барьер после Find законен: дедуп требует все находки разом.

**Схема находки finder'а** (передавай через `schema`):

```json
{
  "type": "object",
  "required": ["findings", "coverage_notes"],
  "properties": {
    "findings": { "type": "array", "items": { "type": "object",
      "required": ["axis", "severity", "title", "file", "line", "invariant", "failure_scenario"],
      "properties": {
        "axis": { "type": "string" },
        "severity": { "enum": ["BLOCKER", "HIGH", "MEDIUM", "LOW"] },
        "title": { "type": "string" },
        "file": { "type": "string" },
        "line": { "type": "number" },
        "invariant": { "type": "string" },
        "evidence": { "type": "string" },
        "failure_scenario": { "type": "string" },
        "fix_sketch": { "type": "string" }
      } } },
    "coverage_notes": { "type": "string" }
  }
}
```

**Промпт finder'а** (шаблон; подставь ось, чеклист, файлы, границы):

```
Ты аудируешь ОДНУ ось проекта oplati_podpicky (весь код, не diff).
Ось: <буква + название>, шард: <охват>.
Сначала прочитай CLAUDE.md (источник правды), затем чеклист <путь> — это
ЖЁСТКИЕ инварианты проекта, не эвристики.
<блок «Жёсткие границы прогона» дословно>
Файлы твоего шарда: <список из Шага 0>.
Для каждого пункта чеклиста проверь код шарда. Читай файлы целиком — не суди
по фрагменту; прослеживай транзакции и вызывающий код. Ищи и нарушение
инварианта, и ОТСУТСТВИЕ обещанной защиты (нет ON CONFLICT, нет timeout, нет
claim'а), и расхождение кода с CLAUDE.md. Severity: BLOCKER = потеря/двойное
движение денег, дыра безопасности, сломанная идемпотентность; HIGH = сломается
при реалистичном сценарии; MEDIUM = сломается при редком; LOW = гигиена.
Каждая находка обязана иметь file:line и конкретный сценарий отказа
(вход/состояние -> неверный результат). Не выходи за свою ось. В
coverage_notes честно перечисли, что НЕ успел осмотреть.
```

**Верификация** (pipeline: каждая находка уходит на проверку, как только её
ось отработала; дедуп — по `file` + сути):

- BLOCKER/HIGH → 2 агента с разными линзами, `effort: 'max'`:
  *refuter* («опровергни: докажи по коду, что защита есть или сценарий
  невозможен; при сомнении — refuted») и *impact* («воспроизведи сценарий по
  коду шаг за шагом, оцени severity заново»). Выживает, если refuter НЕ
  опроверг; severity берётся от impact.
- MEDIUM → 1 refuter (effort сессии).
- LOW → без верификации, в отчёте пометить «не верифицировано».
- Верификатору передавай список известных проблем из Шага 0: совпадение →
  `known: true`.
- Схема вердикта: `{ "verdict": "CONFIRMED|REFUTED|UNCERTAIN", "severity":
  "...", "known": boolean, "reasoning": "..." }`.
- `log()` каждое усечение охвата — молчаливых капов быть не должно.

**Критик полноты:** после Verify один агент читает сводку находок +
coverage_notes всех finder'ов и отвечает: какие зоны/инварианты остались
неосмотренными? Если назвал конкретные пробелы — ОДИН добор: finders по
пробелам, их находки через ту же верификацию. Дальше — стоп (не зацикливаться).

## Шаг 2 — отчёт

Сохрани полный отчёт в `AUDIT-<YYYY-MM-DD>.md` в корне репозитория (НЕ
коммитить) и дай резюме в чате. Структура:

1. **Сводка** — таблица: ось × количество по severity; результат baseline
   (typecheck/тесты).
2. **Топ-риски** — до 10 находок сквозным ранжированием: сначала деньги
   (потеря/двойное движение), потом безопасность, потом доступность.
3. **Находки по осям** — внутри оси: CONFIRMED по severity, затем UNCERTAIN,
   затем непроверенные LOW. Формат строки:
   `[SEVERITY][вердикт] file:line — инвариант — суть — сценарий отказа — набросок фикса`.
4. **Уже известно** — `known`-находки со ссылкой на BACKLOG/incidents (для
   сверки, что они всё ещё актуальны).
5. **Покрытие** — что осмотрено, что нет (из coverage_notes), сколько агентов
   и находок отсеяно верификацией.

Правила: ничего не выдумывать (нет file:line → находка не попадает в отчёт);
REFUTED-находки в отчёт не включать (кроме счётчика в «Покрытии»); **ничего не
чинить в этом прогоне** — по итогам предложить перенести подтверждённое в
`docs/BACKLOG.md` и чинить пачками по 3–4 с коммитом (рабочий стиль владельца).

## Границы скилла

- Не заменяет `full-review` (diff перед merge) и внешние ревью — дополняет их
  полнопроектным охватом.
- Не трогает прод: live-проверки (журнал миграций на VPS, env Dokploy,
  вебхук-подписки в кабинетах провайдеров) — отдельная сессия по явной просьбе.
