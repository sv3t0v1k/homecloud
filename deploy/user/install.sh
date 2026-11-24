#!/bin/sh
# HomeCloud user installer — bootstrap оркестратор.
# Запуск из checkout репозитория root-ом. Фазы: probe -> вопросы -> generate ->
# preflight -> start -> summary. Fail-closed: любая фаза падает — STOP.
set -eu

fail() { echo "STOP install: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail 'запускайте от root (sudo)'
command -v python3 >/dev/null 2>&1 || fail 'нужен python3'
command -v openssl >/dev/null 2>&1 || fail 'нужен openssl'

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || fail
project_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P) || fail
installer_dir="$script_dir"

MODE=interactive
INSTALL_ROOT=/opt/homecloud
PROJECT_NAME=homecloud
START=1
ANSWERS_OVERRIDE=''
IMAGES=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --defaults) MODE=defaults;;
    --interactive) MODE=interactive;;
    --root) INSTALL_ROOT=${2:?}; shift;;
    --name) PROJECT_NAME=${2:?}; shift;;
    --answers) ANSWERS_OVERRIDE=${2:?}; shift;;
    --images) IMAGES=${2:?}; shift;;
    --no-start) START=0;;
    *) fail "неизвестный аргумент: $1";;
  esac
  shift
done

case "$INSTALL_ROOT" in
  /*) ;;
  *) fail '--root: абсолютный путь';;
esac
case "$PROJECT_NAME" in
  *[!a-z0-9-]*|'') fail '--name: строчные латинские буквы, цифры и дефис';;
esac

work=$(mktemp -d /tmp/homecloud-install.XXXXXX) || fail
chmod 700 "$work" || fail
trap 'rm -rf "$work"' EXIT

clean_path=/usr/sbin:/usr/bin:/sbin:/bin
py() { env -i HOME=/root PATH="$clean_path" /usr/bin/python3 -I -B "$@"; }

say() { printf '%s\n' "$*"; }
ask() {
  # ask <prompt> <default>; печатает default в квадратных скобках.
  prompt=$1; default=$2
  if [ "$MODE" = defaults ] || [ ! -t 0 ]; then
    printf '%s\n' "$default"; return 0
  fi
  printf '%s [%s]: ' "$prompt" "$default" >&2
  IFS= read -r reply || reply=''
  [ -n "$reply" ] && printf '%s\n' "$reply" || printf '%s\n' "$default"
}

# --- Фаза 1: probe -----------------------------------------------------------
say '==> Проверяю среду (только чтение)'
py "$installer_dir/probe.py" --output "$work/probe.json" || fail 'probe не пройден'
warnings=$(py -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["warnings"]))' "$work/probe.json")
[ "$warnings" = 0 ] || say "    предупреждений: $warnings (см. probe.json при отладке)"

arch=$(py -c 'import json,sys; print(json.load(open(sys.argv[1]))["system"]["arch"])' "$work/probe.json")
[ "$arch" = x86_64 ] || fail "архитектура $arch не квалифицирована (нужна x86_64)"

docker_ok=$(py -c 'import json,sys; d=json.load(open(sys.argv[1]))["docker"]; print("yes" if d["present"] and d["compose_version"] else "no")' "$work/probe.json")
[ "$docker_ok" = yes ] || fail 'нужен работающий Docker с плагином compose'

# --- Умолчания из probe -------------------------------------------------------
primary_ip=$(py -c 'import json,sys; print(json.load(open(sys.argv[1]))["network"]["primary_ip"] or "127.0.0.1")' "$work/probe.json")
busy=$(py -c 'import json,sys; print(",".join(map(str,json.load(open(sys.argv[1]))["network"]["listening_tcp_ports"])))' "$work/probe.json")
port_free() { case ",$busy," in *,"$1",*) return 1;; *) return 0;; esac; }
default_https=443; port_free 443 || default_https=8443
default_http=80;  port_free 80  || default_http=8080

# UUID/mount корневого раздела и подходящего раздела под хранилище.
root_uuid=$(py -c 'import json,sys; m=json.load(open(sys.argv[1]))["mounts"]; print(next((r["uuid"] for r in m if r["target"]=="/" and r.get("uuid")), ""))' "$work/probe.json")
default_storage_mount=$(py - "$INSTALL_ROOT" <<'PY'
import json, sys
probe = json.load(open(sys.argv[2]))
target = sys.argv[1] + '/data/storage'
best = ''
for row in probe['mounts']:
    mount = row.get('target') or ''
    if mount == '/':
        continue
    if target.startswith(mount.rstrip('/') + '/') and len(mount) > len(best):
        best = mount
print(best)
PY
"$work/probe.json") || fail
default_storage_uuid=''
if [ -n "$default_storage_mount" ]; then
  default_storage_uuid=$(py - "$default_storage_mount" <<'PY'
import json, sys
probe = json.load(open(sys.argv[2]))
want = sys.argv[1]
print(next((r['uuid'] for r in probe['mounts'] if r['target'] == want and r.get('uuid')), ''))
PY
"$work/probe.json") || fail
fi

# --- Фаза 2: вопросы ---------------------------------------------------------
if [ -n "$ANSWERS_OVERRIDE" ]; then
  cp "$ANSWERS_OVERRIDE" "$work/answers.json"
else
  say '==> Параметры установки (Enter — принять предложенное)'
  public_host=$(ask 'Адрес сервера (домен или IP)' "$primary_ip")
  https_port=$(ask 'HTTPS порт' "$default_https")
  http_port=$(ask 'HTTP порт' "$default_http")
  db_dir=$(ask 'Каталог базы данных' "$INSTALL_ROOT/data/postgres")
  storage_dir=$(ask 'Каталог файлов' "$INSTALL_ROOT/data/storage")
  storage_mount=$(ask 'Mountpoint раздела с файлами' "$default_storage_mount")
  storage_uuid=$(ask 'UUID раздела с файлами' "$default_storage_uuid")
  db_uuid="$root_uuid"
  if [ "$(ask 'База данных на отдельном диске? (y/N)' 'N')" = y ]; then
    db_mount=$(ask 'Mountpoint раздела базы' '')
    db_uuid=$(ask 'UUID раздела базы' '')
    layout_mode=two-disk
  else
    db_mount=''
    layout_mode=system-root
  fi
  if [ -z "$IMAGES" ]; then
    backend_image=$(ask 'Образ backend (registry/image:tag@digest)' '')
    frontend_image=$(ask 'Образ frontend (registry/image:tag@digest)' '')
  else
    case "$IMAGES" in *,*) ;; *) fail '--images: backend,frontend';;
    esac
    backend_image=${IMAGES%%,*}
    frontend_image=${IMAGES#*,}
  fi
  [ -n "$backend_image" ] || fail 'образ backend обязателен (RELEASE_BACKEND_IMAGE)'
  [ -n "$frontend_image" ] || fail 'образ frontend обязателен (RELEASE_FRONTEND_IMAGE)'
  [ -n "$storage_uuid" ] || fail 'не удалось определить UUID раздела с файлами; задайте явно'
  [ -n "$storage_mount" ] || fail 'не удалось определить mountpoint раздела; задайте явно'
  [ -n "$db_uuid" ] || fail 'не удалось определить UUID раздела базы; задайте явно'

  py - "$PROJECT_NAME" "$public_host" "$primary_ip" "$http_port" "$https_port" \
     "$db_dir" "$storage_dir" "$storage_uuid" "$storage_mount" \
     "$backend_image" "$frontend_image" "$INSTALL_ROOT" \
     "$layout_mode" "$db_uuid" "$db_mount" > "$work/answers.json" <<'PY'
import json, sys
(name, host, bind_ip, http, https, db_dir, storage_dir,
 storage_uuid, storage_mount, backend, frontend, root,
 layout_mode, db_uuid, db_mount) = sys.argv[1:16]
layout = {'mode': layout_mode,
          'db_dir': db_dir, 'storage_dir': storage_dir,
          'storage_uuid': storage_uuid, 'storage_mount': storage_mount,
          'db_uuid': db_uuid}
if layout_mode == 'two-disk':
    layout['db_mount'] = db_mount
answers = {
    'project_name': name, 'public_host': host, 'public_bind_ip': bind_ip,
    'http_port': int(http), 'https_port': int(https),
    'layout': layout,
    'backend_image': backend, 'frontend_image': frontend,
    'postgres_uid': 70, 'postgres_gid': 70,
    'backend_uid': 1001, 'backend_gid': 65533,
    'install_root': root,
    'tls_cert_dir': root + '/.runtime/tls',
    'acme_webroot_dir': root + '/.runtime/acme',
    'ingress_subnet': '172.29.0.0/24', 'ingress_proxy_ip': '172.29.0.10',
    'backend_proxy_subnet': '172.30.0.0/24', 'frontend_proxy_ip': '172.30.0.10',
}
json.dump(answers, sys.stdout, ensure_ascii=False, indent=2)
PY
fi

# --- Фаза 3: генерация -------------------------------------------------------
say '==> Генерирую конфигурацию (секреты, gates, markers, TLS)'
py "$installer_dir/generate.py" --answers "$work/answers.json" --mode apply || fail 'генерация отклонена'

# --- Фаза 4: preflight (тот же конвейер, что и в runbook) --------------------
say '==> Выполняю preflight'
py "$project_root/deploy/linux/preflight.py" \
  --inventory "$INSTALL_ROOT/.runtime/host-disks.json" \
  --env-file "$INSTALL_ROOT/.runtime/runtime.env" || fail 'preflight отказал'

# --- Фаза 5: старт -----------------------------------------------------------
if [ "$START" = 1 ]; then
  say '==> Скачиваю образы и запускаю'
  env -i HOME=/root PATH="$clean_path" DOCKER_CONFIG="$INSTALL_ROOT/.runtime/docker" \
    docker compose --project-directory "$project_root" \
    --env-file "$INSTALL_ROOT/.runtime/runtime.env" \
    -f "$project_root/docker-compose.yml" \
    -f "$project_root/docker-compose.production.yml" \
    pull || fail 'не удалось скачать образы'
  env -i HOME=/root PATH="$clean_path" DOCKER_CONFIG="$INSTALL_ROOT/.runtime/docker" \
    docker compose --project-directory "$project_root" \
    --env-file "$INSTALL_ROOT/.runtime/runtime.env" \
    -f "$project_root/docker-compose.yml" \
    -f "$project_root/docker-compose.production.yml" \
    up -d --wait --wait-timeout 180 || fail 'запуск отклонён'
fi

# --- Фаза 6: сводка ----------------------------------------------------------
https_port=$(py -c 'import json,sys; print(json.load(open(sys.argv[1]))["https_port"])' "$work/answers.json")
host=$(py -c 'import json,sys; print(json.load(open(sys.argv[1]))["public_host"])' "$work/answers.json")
say ''
say 'Готово.'
say "  Веб-интерфейс:  https://$host:$https_port"
say '  Статус:         docker compose -f docker-compose.yml -f docker-compose.production.yml ps'
say "  Секреты:        $INSTALL_ROOT/.runtime/runtime.env (root-only)"
if [ "$START" = 1 ]; then
  say '  Первый вход:    зарегистрируйте первого пользователя — это будет владелец.'
fi
