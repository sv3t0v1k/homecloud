# Запуск HomeCloud через Docker Compose

На Mac основной файл — `docker-compose.yml`. Он запускает PostgreSQL, backend и
frontend на http://localhost:8080. Redis отключён; TLS для ежедневной работы не нужен.
`docker-compose.local.yml` — только opt-in API port для Vite HMR.
`docker-compose.production.yml` — Linux override с TLS и SSD DB/HDD files.
Это подготовка конфигурации: mini-PC и физические диски не квалифицированы,
production **NOT_READY / NO_GO**, SSD uploads **OFF**. COMPLETE не установлен.

## Первый запуск на новом Mac

Docker Compose >=2.24.4 нужен для production `!override` ([правила merge](https://docs.docker.com/reference/compose-file/merge/)).
Выполнять из корня репозитория. Следующая подготовка предназначена для **новой** БД;
при существующем `.env`/БД не заменять DB credentials новыми.

```sh
# Команда не перезаписывает существующий .env.
(umask 077; test -e .env || cp .env.example .env)
python3 - <<'PYENV'
from pathlib import Path
import secrets
p = Path('.env')
s = p.read_text()
for key in ('DB_PASSWORD', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'REDIS_PASSWORD'):
    s = s.replace(key + '=\n', key + '=' + secrets.token_hex(32) + '\n')
p.write_text(s)
p.chmod(0o600)
PYENV
# Никогда не публиковать вывод config без --quiet: он содержит секреты.
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 180
docker compose ps
```

Новые named volumes автоматически получают `/storage` и `.tmp` UID1001/mode0700
через copy-up из image. Existing volumes не chown'ятся и не очищаются. Нет `VOLUME`
в Dockerfile, fixed container names и fixed external volume names. С project
`homecloud-preview` используются прежние `homecloud-preview_db_data` и
`homecloud-preview_storage_data`; смена project выбирает другую БД/storage.
Docker Desktop сохраняет данные внутри своей Linux VM, а не на отдельном HDD.

Image собирает native addon внутри Linux под текущую архитектуру. Не переносить
Mac `node_modules` или `.node` в Linux; bind source code поверх `/app` не нужен.
Backend entrypoint выполняет `migration:run --transaction all` перед API только
при стандартной команде `node dist/main.js`. Ошибка останавливает startup. Helper
команды `sh`, `node -e`, `npm run migration:run` не запускают скрытых миграций.
На startup приложение выполняет штатную cleanup expired/orphaned legacy sessions.

## Обновление и ежедневная работа

```sh
# При изменении кода/config: writers остановить ДО migration и build/up.
docker compose stop frontend backend
docker compose up -d --build --wait --wait-timeout 180
# Сохранить контейнеры/volumes и штатно перезапустить процесс:
docker compose restart backend frontend
# Штатная остановка/возобновление:
docker compose stop
docker compose start --wait
# Readiness внутри backend, закрыта снаружи nginx:
docker compose exec -T backend node docker/healthcheck.cjs
docker compose logs --tail=80 backend
```

`restart` не применяет новую env/config/image. Не запускать два backend writers
или миграцию параллельно API. Перед destructive migration/restore или удалением
volumes требуется отдельное разрешение владельца и согласованный backup contract.
`down -v`, `prune`, удаление/пересоздание БД и чужих ресурсов не входят в эти команды.

Для **существующего Mac baseline** использовать прежние DB_NAME/DB_USER/password
и JWT из защищённого runtime env; dev требует дополнительно непустой
REDIS_PASSWORD (генератор выше, приложение Redis не использует). Не менять пароль
PostgreSQL только через env: existing PG volume не сбрасывает credentials.
Старый TLS ingress после перехода на HTTP не нужен; если он запущен, отдельно
остановить только `homecloud-preview-ingress-1`. Старые networks/volumes не prune.
Завершённые датированные TLS/50GiB checkpoints остаются историей, не текущим стартом.

## Vite HMR и Redis — опционально

```sh
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build --wait
cd frontend
npm ci
npm run dev -- --host 127.0.0.1
```

Vite http://localhost:5173 проксирует `/api` и `/socket.io` в localhost:3000.
API port3000 согласован с Vite proxy; конфигурируемый port отдельно не объявляется.
Вернуться к одному основному Compose — `docker compose up -d --wait`, затем проверить
отсутствие backend опубликованного порта. Публичные health/metrics routes nginx закрыты.
Mac не доверяет forwarded client headers; IP rate-limit за nginx общий для локального
пользователя. Production ниже доверяет одному exact frontend peer.

```sh
# Redis не хранит sessions приложения, не входит в readiness, не обязателен.
docker compose --profile redis up -d --wait redis
```

Пароль Redis должен быть hex минимум32символа. Его лимит256MiB включает контейнер;
не использовать этот опциональный сервис как неограниченный production cache.

## Первый пользователь и квота

Публичная самостоятельная регистрация отключена. Endpoint
`POST /api/v1/auth/register` возвращает HTTP 403 `REGISTRATION_DISABLED`.
Первый ADMIN создаётся оператором сервера, а не браузером.

### Новая пустая БД

Сначала запустить Compose по инструкции выше: backend применит миграции.
Затем выполнить из того же корня проекта, с теми же Compose-файлами,
project name и конфигурацией:

```sh
docker compose stop frontend backend

docker compose run --rm --no-deps backend \
  node dist/users/admin-bootstrap-cli.js \
  bootstrap create \
  --email admin@example.com \
  --name "Администратор"

docker compose up -d --wait --wait-timeout 180
docker compose exec -T backend node docker/healthcheck.cjs
```

Заменить пример email своим адресом. CLI запросит новый пароль и его
подтверждение в интерактивном терминале, без отображения вводимых символов.
Пароль: не менее 12 символов и не более 72 байт UTF-8.
Не передавать пароль через argv, env, pipe или shell history.

Bootstrap требует полностью подготовленную схему, остановленный backend
и тот же storage root-fence, что и обычный API. Повторный запуск для
существующего активного ADMIN не меняет его запись или пароль.

### Существующая БД

Не создавать новую БД и не удалять существующих пользователей.
Если активного ADMIN ещё нет, остановить backend и повысить конкретного
активного пользователя по его точным id и email командой
`bootstrap promote --user-id ID --email EMAIL`.

Полный операторский контракт, ограничения и порядок возобновления работы:
[Первоначальная настройка администратора](admin-bootstrap.md).
Для установленного Linux использовать именно его штатные Compose-файлы,
project name и внешнюю конфигурацию, включая startup gate и maintenance mount.

### Вход и квота

Login UI: http://localhost:8080/login. Новый ADMIN получает начальную квоту 0.
Роль ADMIN сама по себе не разрешает превышать квоту.

До появления полноценного admin API разрешён только прежний локальный
операторский способ настройки квоты одноразовой dev-базы. Не применять
пример ниже на установленном сервере или к уже работающим пользователям.

Для свежего локального ADMIN без файлов и активных операций остановить
backend, проверить его точные id и email в `psql`, затем назначить
начальную квоту. Пример для 1 GiB:

```sql
UPDATE users
SET "storageQuota" = 1073741824
WHERE id = 1
  AND email = 'admin@example.com'
  AND role = 'ADMIN'
  AND "storageQuota" = 0
  AND "storageUsed" = 0
  AND NOT EXISTS (SELECT 1 FROM files)
  AND NOT EXISTS (SELECT 1 FROM upload_sessions)
  AND NOT EXISTS (SELECT 1 FROM file_copy_operations);
```

Заменить id и email фактическими значениями проверенной записи.
Ожидается ровно одна изменённая строка. Если условие не выполнено,
не ослаблять его. Не изменять password hashes, role, sessionVersion,
storageUsed или upload/copy journals вручную.

После настройки снова запустить тот же Compose и проверить readiness.
Управление произвольными пользователями и квотами через admin API
относится к следующим этапам BE-ADMIN.

## Подготовка Linux mini-PC

Актуальная инструкция D3: [Linux mini-PC: host preflight, запуск и восстановление](linux-mini-pc.md).
Production override сохраняет SSD DB/HDD `/storage`, SSD uploads OFF/manual и отсутствие
всех четырёх SSD mapping vars. Linux использует `restart: unless-stopped` и gate в entrypoint каждого DB/backend startup;
systemd unit опционален. Отдельные project/ports/subnets задать после проверки конфликтов;
Mac main Compose сохраняет прежний restart policy. Перед startup проверить UUID/serial,
source, UID/GID, capacity и native image; наличие bind каталога не доказывает mount.
Backend production `1001:65533` согласован с image nextjs и D1 restore ownership.
520 после legacy-only применения не enroll'ит SSD через env: требуется отдельный reviewed
forward path. Mini-PC/physical disks/SSD activation не проверены, production NO_GO.

## D1 backup/restore

D1 scripts используют **external** absolute env file mode0600, COMPOSE_FILE absolute
colon-separated список и COMPOSE_PROJECT_NAME. Репозиторный `.env` ими не принимается.
Скопировать env во внешнее защищённое место. Изменить существующий COMPOSE_PROJECT_NAME
(не добавлять второй ключ); добавить COMPOSE_FILE и STORAGE_PATH (paths под свой checkout):

```dotenv
COMPOSE_FILE=/Users/aleksejkozemakin/Desktop/HomeCloud/docker-compose.yml
COMPOSE_PROJECT_NAME=homecloud-preview
STORAGE_PATH=/storage
```

Для Linux COMPOSE_FILE включает absolute main:production.
В external recovery env также обязательно задать `BACKEND_IMAGE` literal reference,
совпадающий с `RELEASE_BACKEND_IMAGE` (Mac сейчас `homecloud-backend:dev`); default helper
`homecloud-backend` не является эквивалентом. После Linux D1 recovery возвращать stack
через per-start gate и host preflight по [D3 инструкции](linux-mini-pc.md).
Recovery allowlist расширен canonical
Compose knobs; реальные values должны совпадать с активными контейнерами. Явный
backend.image, image ID/config hash и фактический mount source проверяет D1; external
volume names и STORAGE_VOLUME не являются альтернативными restore targets.
[Backup contracts](backup-and-restore.md), [D1 evidence](../evidence/archive/d1-backup-restore-20261013/report.md).
Backup/restore требует maintenance write barrier; pending SSD recovery отвергается.
В этой задаче destructive restore не запускается.


Production release qualification не переносится с прежних standalone manifests.
Новый release helper учитывает canonical main+production checksum; старые checksums
с новым helper не проходят source-qualified validation даже на прежнем source root.
Формат/schema/image-only validation сохраняются; исторические archives требуют своего
старого helper либо отдельной адаптации и requalification. `release-pair-runtime.py`
и `final-production-e2e.py` не квалифицированы для новой topology. Daily Mac smoke
проверяет dev images; immutable production pair, deployment/rollback/offsite остаются
отдельным gate, production NO_GO. Для будущего Linux rollout использовать проверенные
неизменяемые release images вместо Mac `:dev` tags.
