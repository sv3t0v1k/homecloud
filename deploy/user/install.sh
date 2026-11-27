#!/bin/sh
# HomeCloud user installer — bootstrap оркестратор.
# Запуск из checkout репозитория root-ом. Фазы: probe -> вопросы -> generate ->
# pull -> preflight -> start -> bootstrap обновлений -> systemd -> summary.
# Fail-closed: любая фаза падает — STOP (bootstrap/systemd — предупреждение,
# сервер уже работает; команды повтора печатаются).
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
PROJECT_NAME=homecloud-user
CHANNEL=release
CHANNEL_GIVEN=0
START=1
ANSWERS_OVERRIDE=''
IMAGES=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --defaults) MODE=defaults;;
    --interactive) MODE=interactive;;
    --root) INSTALL_ROOT=${2:?}; shift;;
    --name) PROJECT_NAME=${2:?}; shift;;
    --channel) CHANNEL=${2:?}; CHANNEL_GIVEN=1; shift;;
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
case "$CHANNEL" in
  release|test) ;;
  *) fail '--channel: release или test';;
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

# UUID/mount/serial корневого раздела и подходящего раздела под хранилище.
root_uuid=$(py -c 'import json,sys; m=json.load(open(sys.argv[1]))["mounts"]; print(next((r["uuid"] for r in m if r["target"]=="/" and r.get("uuid")), ""))' "$work/probe.json")
mount_serial() {
  py - "$1" "$work/probe.json" <<'PY'
import json, sys
probe = json.load(open(sys.argv[2]))
want = sys.argv[1]
print(next((r.get('serial') or '' for r in probe['mounts'] if r['target'] == want), ''))
PY
}
default_storage_mount=$(py - "$INSTALL_ROOT" "$work/probe.json" <<'PY'
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
) || fail
default_storage_uuid=''
if [ -n "$default_storage_mount" ]; then
  default_storage_uuid=$(py - "$default_storage_mount" "$work/probe.json" <<'PY'
import json, sys
probe = json.load(open(sys.argv[2]))
want = sys.argv[1]
print(next((r['uuid'] for r in probe['mounts'] if r['target'] == want and r.get('uuid')), ''))
PY
) || fail
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
  if [ "$CHANNEL_GIVEN" = 0 ]; then
    CHANNEL=$(ask 'Канал обновлений (release — стабильные, test — тестовые)' 'release')
    case "$CHANNEL" in
      release|test) ;;
      *) fail 'канал обновлений: release или test';;
    esac
  fi
  if [ "$(ask 'База данных на отдельном диске? (y/N)' 'N')" = y ]; then
    db_mount=$(ask 'Mountpoint раздела базы' '')
    db_uuid=$(ask 'UUID раздела базы' '')
    db_serial=$(mount_serial "$db_mount")
    layout_mode=two-disk
  else
    db_mount=''
    db_serial=$(mount_serial "/")
    layout_mode=system-root
  fi
  storage_serial=$(mount_serial "$storage_mount")
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
  [ -n "$storage_serial" ] || fail 'не удалось определить serial диска с файлами (probe)'
  [ -n "$db_uuid" ] || fail 'не удалось определить UUID раздела базы; задайте явно'
  [ -n "$db_serial" ] || fail 'не удалось определить serial диска базы (probe)'

  py - "$PROJECT_NAME" "$project_root" "$public_host" "$primary_ip" "$http_port" "$https_port" \
     "$db_dir" "$storage_dir" "$storage_uuid" "$storage_mount" \
     "$backend_image" "$frontend_image" "$INSTALL_ROOT" \
     "$layout_mode" "$db_uuid" "$db_mount" "$CHANNEL" \
     "$db_serial" "$storage_serial" > "$work/answers.json" <<'PY'
import json, sys
(name, project_root, host, bind_ip, http, https, db_dir, storage_dir,
 storage_uuid, storage_mount, backend, frontend, root,
 layout_mode, db_uuid, db_mount, channel,
 db_serial, storage_serial) = sys.argv[1:20]
layout = {'mode': layout_mode,
          'db_dir': db_dir, 'storage_dir': storage_dir,
          'storage_uuid': storage_uuid, 'storage_mount': storage_mount,
          'db_uuid': db_uuid,
          'db_serial': db_serial, 'storage_serial': storage_serial}
if layout_mode == 'two-disk':
    layout['db_mount'] = db_mount
answers = {
    'project_name': name, 'project_root': project_root,
    'public_host': host, 'public_bind_ip': bind_ip,
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
    'update_channel': channel,
}
json.dump(answers, sys.stdout, ensure_ascii=False, indent=2)
PY
fi

# --- Фаза 3: генерация -------------------------------------------------------
say '==> Генерирую конфигурацию (секреты, /etc/homecloud, worker обновлений, TLS)'
py "$installer_dir/generate.py" --answers "$work/answers.json" --mode apply || fail 'генерация отклонена'

compose() {
  env -i HOME=/root PATH="$clean_path" DOCKER_CONFIG=/etc/homecloud/docker \
    docker compose --project-directory "$project_root" \
    --env-file /etc/homecloud/runtime.env "$@"
}

compose_release() {
  if [ "$CHANNEL" = release ]; then
    compose -f "$project_root/docker-compose.yml" \
            -f "$project_root/docker-compose.production.yml" \
            -f "$project_root/docker-compose.production-updates.yml" "$@"
  else
    compose -f "$project_root/docker-compose.yml" \
            -f "$project_root/docker-compose.production.yml" "$@"
  fi
}

# --- Фаза 4: образы (preflight требует локальные linux/amd64 образы) ----------
say '==> Скачиваю образы'
compose_release pull || fail 'не удалось скачать образы'

# --- Фаза 5: preflight (тот же конвейер, что и в runbook) ---------------------
say '==> Выполняю preflight'
if [ "$CHANNEL" = release ]; then
  (cd "$project_root" && py deploy/linux/preflight.py \
    --inventory /etc/homecloud/host-disks.json \
    --env-file /etc/homecloud/runtime.env \
    --updates "$project_root/docker-compose.production-updates.yml") || fail 'preflight отказал'
else
  (cd "$project_root" && py deploy/linux/preflight.py \
    --inventory /etc/homecloud/host-disks.json \
    --env-file /etc/homecloud/runtime.env) || fail 'preflight отказал'
fi

# --- Фаза 6: старт ------------------------------------------------------------
if [ "$START" = 1 ]; then
  say '==> Запускаю'
  compose_release up -d --wait --wait-timeout 180 || fail 'запуск отклонён'
fi

# --- Фаза 7: bootstrap обновлений и systemd (только release-канал) ------------
if [ "$START" = 1 ] && [ "$CHANNEL" = release ]; then
  say '==> Привязываю установленный релиз (bootstrap обновлений)'
  if py /usr/local/sbin/homecloud-user-update bootstrap; then
    say '    installed-lock привязан к текущему релизу'
  else
    say '    предупреждение: bootstrap не выполнен — сервер работает, но'
    say '    кнопка обновления не активна. Повторите позже:'
    say '    sudo /usr/local/sbin/homecloud-user-update bootstrap'
  fi
  say '==> Включаю службы обновлений'
  if systemctl daemon-reload && \
     systemctl enable --now homecloud-user-update.path && \
     systemctl enable --now homecloud-user-update-archive.timer; then
    say '    homecloud-user-update.path + archive.timer активны'
  else
    say '    предупреждение: systemd-юниты не включены — сервер работает, но'
    say '    самообновление не активно. Включите вручную:'
    say '    sudo systemctl enable --now homecloud-user-update.path homecloud-user-update-archive.timer'
  fi
fi

# --- Фаза 8: сводка -----------------------------------------------------------
https_port=$(py -c 'import json,sys; print(json.load(open(sys.argv[1]))["https_port"])' "$work/answers.json")
host=$(py -c 'import json,sys; print(json.load(open(sys.argv[1]))["public_host"])' "$work/answers.json")
say ''
say 'Готово.'
say "  Веб-интерфейс:  https://$host:$https_port"
say '  Статус:         docker compose -f docker-compose.yml -f docker-compose.production.yml ps'
say '  Секреты:        /etc/homecloud/runtime.env (root-only)'
if [ -z "$ANSWERS_OVERRIDE" ]; then
  say "  Канал обновлений: $CHANNEL"
fi
if [ "$START" = 1 ]; then
  say '  Первый вход:    зарегистрируйте первого пользователя — это будет владелец.'
  if [ "$CHANNEL" = release ]; then
    say '  Кнопка обновлений: после регистрации владельца добавьте его числовой id'
    say '  в /etc/homecloud/runtime.env (UPDATE_ADMIN_USER_ID=1) и перезапустите:'
    say '  docker compose --env-file /etc/homecloud/runtime.env -f docker-compose.yml -f docker-compose.production.yml -f docker-compose.production-updates.yml up -d'
  fi
fi
