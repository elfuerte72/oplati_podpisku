# Происхождение скиллов в этой папке

## Из плагина `agent-skills` (Addy Osmani), MIT

Скопированы 2026-08-14 из `addy-agent-skills/agent-skills` и с тех пор живут как наши —
апстрим-обновления к ним не приходят, правки под проект вносим сами:

`api-and-interface-design`, `ci-cd-and-automation`, `deprecation-and-migration`,
`doubt-driven-development`, `frontend-ui-engineering`, `observability-and-instrumentation`,
`performance-optimization`, `security-and-hardening`.

Остальные скиллы того плагина не копировались: их темы закрывает `mattpocock-skills`
(подключён как плагин, не копия) — процессные скиллы там плотнее и с жёсткими гейтами.
Разбор — в `docs/CHANGELOG.md` за 2026-08-14.

```
MIT License

Copyright (c) 2025 Addy Osmani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Наши собственные

`full-audit`, `full-review`, `oplatishka-design` — написаны под этот проект, знают его
инварианты. Симлинки `higgsfield-*` ведут в `.agents/skills/` и в git не попадают.
