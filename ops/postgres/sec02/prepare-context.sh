#!/usr/bin/env bash
# Подготовка минимального контекста из закреплённых компонентов.
set -euo pipefail
umask 077

test "$#" -eq 2 || test "$#" -eq 3

DEST="$1"
GOSU="$2"
APK="${3:-}"

HERE="$(cd "$(dirname "$0")" && pwd -P)"

GOSU_SHA="81b8e04f7ec075babb1bd154c4dbdb3b9e07c8a3eb21f3f7537c7d5bc88d351a"
APK_SHA="b7d56295eab909875e724992b53ccc242fa792b40d682f303595f958a97b0224"
PACKAGE="libxml2-2.13.9-r5.apk"

URL="https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/$PACKAGE"

digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

test -f "$GOSU"
test ! -L "$GOSU"
test "$(digest "$GOSU")" = "$GOSU_SHA"

if [ -n "$APK" ]; then
  test -f "$APK"
  test ! -L "$APK"
  test "$(digest "$APK")" = "$APK_SHA"
fi

test ! -e "$DEST"
test ! -L "$DEST"

mkdir -m 700 "$DEST"

cp "$HERE/Dockerfile" "$DEST/Dockerfile"
cp "$GOSU" "$DEST/gosu"

if [ -n "$APK" ]; then
  cp "$APK" "$DEST/$PACKAGE"
else
  curl --fail --silent --show-error --location \
    --proto '=https' \
    --proto-redir '=https' \
    --output "$DEST/$PACKAGE" \
    "$URL"
fi

test "$(digest "$DEST/gosu")" = "$GOSU_SHA"
test "$(digest "$DEST/$PACKAGE")" = "$APK_SHA"

chmod 0644 "$DEST/Dockerfile" "$DEST/$PACKAGE"
chmod 0755 "$DEST/gosu"

for FILE in Dockerfile gosu "$PACKAGE"
do
  printf '%s  %s\n' "$(digest "$DEST/$FILE")" "$FILE"
done

echo "POSTGRES_BUILD_CONTEXT_PASS"
