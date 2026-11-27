#!/bin/sh
# HomeCloud bootstrap — установка одной командой без предварительного
# клонирования репозитория.
#
#   curl -fsSL https://raw.githubusercontent.com/sv3t0v1k/homecloud/main/deploy/user/bootstrap.sh | sudo sh
#
# Что делает: скачивает копию репозитория (release-тег — с проверкой подписи
# Ed25519 и хэшей исходников по подписанному release-lock.json, см. bootstrap.py),
# раскладывает её в фиксированный системный каталог (по умолчанию
# /opt/homecloud/repo, рядом с данными; НЕ текущий каталог терминала — путь
# должен быть стабильным, на него ссылаются compose-проект и worker
# обновлений) и запускает оттуда пользовательский установщик install.sh.
# Все незнакомые аргументы передаются в install.sh (--root, --channel,
# --images, --defaults, --answers, --no-start, --name).
#
# Доверие: сам bootstrap.sh (+ bootstrap.py при запуске по pipe) доставляются
# по HTTPS и являются единственной TOFU-точкой; весь остальной носитель
# (исходники по хэшам из подписанного lock, образы по digest из lock)
# проверяется подписью релизов до запуска установки.
#
# Собственные параметры:
#   --tag <тег>      конкретный подписанный релиз
#                    без тега — последний стабильный RELEASE
#                    для beta обязательно: --tag vX.Y.Z-beta.N
#   --ref <ветка>    ветка/коммит БЕЗ проверки подписи (только test-канал)
#   --repo-dir <d>   каталог для копии репозитория (умолчание <root>/repo)
#   --local-bootstrap  явно доверенный локальный checkout
#   HOMECLOUD_RAW    базовый URL raw.githubusercontent для bootstrap.py
#                    при запуске по pipe (умолчание: .../homecloud/main)
set -eu

fail() { echo "STOP bootstrap: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail 'запускайте от root: curl ... | sudo sh'
command -v python3 >/dev/null 2>&1 || fail 'нужен python3'
command -v openssl >/dev/null 2>&1 || fail 'нужен openssl'

TAG=''
REF=''
REPO_DIR=''
INSTALL_ROOT=/opt/homecloud
CHANNEL=release
CHANNEL_GIVEN=0
IMAGES_GIVEN=0
LOCAL_BOOTSTRAP=0

# Обрабатываем только исходные аргументы.
# Аргументы install.sh добавляются в конец "$@".
remaining=$#

while [ "$remaining" -gt 0 ]; do
  opt=$1
  shift
  remaining=$((remaining - 1))

  case "$opt" in
    --tag|--ref|--repo-dir|--root|--channel|--images|--answers|--name)
      [ "$remaining" -gt 0 ] || fail "$opt: отсутствует значение"
      value=$1
      shift
      remaining=$((remaining - 1))

      [ -n "$value" ] || fail "$opt: пустое значение"

      case "$opt" in
        --tag)
          [ -z "$TAG" ] || fail 'повторный --tag'
          TAG=$value
          ;;
        --ref)
          [ -z "$REF" ] || fail 'повторный --ref'
          REF=$value
          ;;
        --repo-dir)
          REPO_DIR=$value
          ;;
        --root)
          INSTALL_ROOT=$value
          set -- "$@" "$opt" "$value"
          ;;
        --channel)
          [ "$CHANNEL_GIVEN" = 0 ] || fail 'повторный --channel'
          CHANNEL=$value
          CHANNEL_GIVEN=1
          ;;
        --images)
          IMAGES_GIVEN=1
          set -- "$@" "$opt" "$value"
          ;;
        *)
          set -- "$@" "$opt" "$value"
          ;;
      esac
      ;;
    --local-bootstrap)
      [ "$LOCAL_BOOTSTRAP" = 0 ] || fail 'повторный --local-bootstrap'
      LOCAL_BOOTSTRAP=1
      ;;
    --defaults|--interactive|--no-start)
      set -- "$@" "$opt"
      ;;
    *)
      fail "неизвестный аргумент: $opt"
      ;;
  esac
done

case "$INSTALL_ROOT" in
  /*) ;;
  *) fail '--root: абсолютный путь';;
esac

case "$CHANNEL" in
  release|test) ;;
  *) fail '--channel: release или test';;
esac

if [ -n "$TAG" ] && [ -n "$REF" ]; then
  fail 'нельзя одновременно --tag и --ref'
fi

# INS-003: неподписанный ref допустим только
# при явно выбранном test-канале.
if [ -n "$REF" ]; then
  [ "$CHANNEL_GIVEN" = 1 ] && [ "$CHANNEL" = test ] \
    || fail '--ref требует явного --channel test'
fi

if [ "$CHANNEL" = test ]; then
  [ -n "$REF" ] || fail 'test-канал требует --ref'
  [ -z "$TAG" ] || fail '--tag предназначен для release'
fi

# RELEASE images come exclusively from the signed release-lock.
if [ "$CHANNEL" = release ] && [ "$IMAGES_GIVEN" = 1 ]; then
  fail '--images разрешён только для test-канала'
fi

# Install.sh не должен повторно спрашивать канал.
set -- "$@" --channel "$CHANNEL"

clean_path=/usr/sbin:/usr/bin:/sbin:/bin
py() { env -i HOME=/root PATH="$clean_path" /usr/bin/python3 -I -B "$@"; }
say() { printf '%s\n' "$*"; }

# Never infer trust from the current working directory.
tmp=''
if [ "$LOCAL_BOOTSTRAP" = 1 ]; then
  case "$0" in
    bootstrap.sh|*/bootstrap.sh) ;;
    *) fail '--local-bootstrap требует запуск файла bootstrap.sh';;
  esac

  [ -f "$0" ] || fail 'локальный bootstrap.sh не найден'

  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || fail

  [ -f "$script_dir/bootstrap.py" ] || fail 'локальный bootstrap.py не найден'

  BOOTSTRAP_PY="$script_dir/bootstrap.py"
else
  base=${HOMECLOUD_RAW:-https://raw.githubusercontent.com/sv3t0v1k/homecloud/main}
  command -v curl >/dev/null 2>&1 || fail 'нужен curl (запуск по pipe)'
  tmp=$(mktemp -d /tmp/homecloud-bootstrap.XXXXXX) || fail
  trap 'rm -rf "$tmp"' EXIT
  say "==> Скачиваю bootstrap-ядро ($base)"
  curl -fsSL "$base/deploy/user/bootstrap.py" -o "$tmp/bootstrap.py" || fail 'не удалось скачать bootstrap.py'
  BOOTSTRAP_PY="$tmp/bootstrap.py"
fi

if [ -z "$TAG" ] && [ -z "$REF" ]; then
  say '==> Определяю последний стабильный релиз HomeCloud'
  TAG=$(py "$BOOTSTRAP_PY" latest-tag) || fail 'не удалось определить стабильный релиз; для beta укажите --tag vX.Y.Z-beta.N'
fi

REPO_DIR=${REPO_DIR:-"$INSTALL_ROOT/repo"}
case "$REPO_DIR" in /*) ;; *) fail '--repo-dir: абсолютный путь';; esac

if [ -n "$REF" ]; then
  say "==> ВНИМАНИЕ: ref $REF скачивается БЕЗ проверки подписи (только для test-канала)"
else
  say "==> Скачиваю релиз $TAG с проверкой подписи"
fi

if [ -n "$TAG" ]; then
  info=$(py "$BOOTSTRAP_PY" fetch --tag "$TAG" --dest "$REPO_DIR") \
    || fail 'не удалось скачать и проверить репозиторий'
else
  info=$(py "$BOOTSTRAP_PY" fetch --ref "$REF" --dest "$REPO_DIR") \
    || fail 'не удалось скачать репозиторий'
fi

# RELEASE: use only the image pair validated by bootstrap.py.
# TEST: explicit images or installer input remain available.
if [ "$CHANNEL" = release ]; then
  pair=$(printf '%s' "$info" | py -c 'import json,sys
value = json.load(sys.stdin)
images = value.get("images")
if not isinstance(images, dict):
    sys.exit(1)
backend = images.get("backend")
frontend = images.get("frontend")
if not isinstance(backend, str) or not backend:
    sys.exit(1)
if not isinstance(frontend, str) or not frontend:
    sys.exit(1)
print(backend + "," + frontend)') \
    || fail 'подписанный release-lock не содержит допустимые образы'

  [ -n "$pair" ] || fail 'пустая пара образов RELEASE'

  say '==> Образы подтверждены подписанным release-lock'
  # install.sh independently reads the retained signed evidence.
fi

if [ -n "$tmp" ]; then
  rm -f -- "$tmp/bootstrap.py"
  rmdir -- "$tmp"
  trap - EXIT
fi

say "==> Запускаю установщик из $REPO_DIR"
exec sh "$REPO_DIR/deploy/user/install.sh" "$@"
