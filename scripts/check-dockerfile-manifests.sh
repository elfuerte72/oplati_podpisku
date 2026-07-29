#!/usr/bin/env bash
# Сверяет список воркспейс-пакетов с манифестами, которые копирует Dockerfile.
#
# Зачем. Стадия `deps` копирует package.json каждого пакета ПОИМЁННО — это
# нужно, чтобы слой `pnpm install` переиспользовался, пока не менялся lockfile.
# Цена — рассинхрон: добавили `packages/<новый>`, забыли строку в Dockerfile, и
# `pnpm install --frozen-lockfile` падает внутри docker build. Локально и в CI
# всё зелёное (там install идёт по всему дереву), падает уже сборка образа —
# то есть в момент выкатки, с невнятной ошибкой про lockfile.
#
# Проверка дешёвая и не требует Docker: сравниваем два списка.
set -euo pipefail

cd "$(dirname "$0")/.."
DOCKERFILE="${1:-Dockerfile}"

missing=()
while IFS= read -r manifest; do
  # Пакет участвует в сборке, только если он в воркспейсе; сам корневой
  # package.json копируется отдельной строкой.
  [ "$manifest" = "./package.json" ] && continue
  path="${manifest#./}"
  if ! grep -qF "COPY $path " "$DOCKERFILE"; then
    missing+=("$path")
  fi
done < <(find ./apps ./packages -maxdepth 2 -name package.json -not -path '*/node_modules/*' 2>/dev/null | sort)

if [ ${#missing[@]} -gt 0 ]; then
  echo "Dockerfile не копирует манифесты воркспейс-пакетов:" >&2
  for m in "${missing[@]}"; do
    echo "  - $m   → добавь в стадию deps: COPY $m $(dirname "$m")/" >&2
  done
  echo >&2
  echo "Без этого 'pnpm install --frozen-lockfile' упадёт уже при docker build," >&2
  echo "то есть в момент выкатки на прод." >&2
  exit 1
fi

echo "Dockerfile копирует манифесты всех воркспейс-пакетов."
