# VM120: полный цикл администрирования пользователей — 2026-11-20

Стенд: `ubuntu@192.168.3.117`, checkout `/home/hs/homecloud-test`, Compose-проект
`homecloud-e2e-120`. Владелец: Alex. Работа выполнена в рамках PR #71.

## Код, review и CI

- Финальный HEAD PR: `e5386b0efb055dfc405c33eff81631aac23037d2`.
- Независимый review финального diff: **APPROVE**, открытых блокеров нет.
- Merge PR #71 в `test`: `f1a8f412994d743589a5679e9e9664d8985306fd`.
- PR CI run `44586448087`: все обязательные проверки успешны, включая
  `recovery-qualification / native-recovery` (38 мин 21 с), backend, frontend,
  configuration, secrets, qualify и phase3-host-drills.
- Push CI run `44594057448`: success; `test-image (backend)`,
  `test-image (frontend)`, `test-pair` и `test-publication-terminal` успешны.
- Artifact `test-channel-1`: ID `14565750638`, не expired.
- Проверенный manifest:
  `b094da95b803761e0c908add87f464ea8dbfa534a9ad512d894712dbc2ab8de8`.
- Backend digest:
  `sha256:a734cc8bee1d12ae40174c583ff40bf0ea06f186dbe4f012897842a054030c9b`.
- Frontend digest:
  `sha256:e19de94bc39d8b5099ed5746e1baf35da55a35c56802476fd8d2f837c923bbc8`.

Локальные проверки перед merge: targeted PostgreSQL 84/84, restore schema 28/28,
restore preflight 16/16, test-channel contract 48/48, frontend 488/488. Полный
backend-набор на macOS: 114 suites / 1900 tests PASS; 11 Linux-only suites / 160
tests не являются Linux-квалификацией и на macOS ожидаемо отклонены secure-fs
границами. Окончательный Linux gate — зелёный CI, указанный выше.

## Исходное состояние и trusted transition

До операции installed и checkout совпадали на
`58a171319bc1b0aca52b9110fa9fb483a5ac7608`, схема содержала 34 миграции.
Git-дерево было чистым; `pending.json`, `request.json`, `current.json` и
`archiving.json` отсутствовали; 4 контейнера были healthy, HTTPS отвечал 200.

Root-owned backup создан в `/root/anchor-backup-20261119T190912Z/`: шесть якорей,
их SHA256, checkout HEAD, список контейнеров и installed checkpoint.

PR меняет `scripts/restore.sh` и restore-тесты вне CI-only белого списка, поэтому
применена утверждённая процедура trusted transition. Дерево `deploy/` и
`docker-compose.project-test-updates.yml` не изменились. Все пять действующих
root-якорей побайтово совпали с git-blob'ами целевого commit; замена якорей не
потребовалась. Checkout переведён ff-only на `f1a8f41`, рабочие контейнеры на этом
шаге не менялись. Верификатор без заявки ожидаемо завершился
`STOP: host evidence verification refused; operator review required`, exit 1.

Discovery опубликовал exact candidate: `commit == sourceGitSha == f1a8f41`,
run `44594057448`, artifact `14565750638`, 35 миграций. Из-за отличия
`sourceGitSha` от прежнего installed SHA заявка подана в inbox по п. 6.1
утверждённой процедуры: формат `homecloud-update-request-v1`, канал `test`,
manifest SHA256 выше, owner `1001:65533`, mode `0600`, atomic tmp + hardlink.
Ручной подмены контейнеров, образов или installer-гейтов не было.

## Установка и пост-проверки

Заявка принята admission 2026-11-19 19:11:18 UTC. Наблюденные статусы:
`RUNNING/INSTALLER` → `VERIFY_IMAGES` → `BACKUP` → `WRITE_REFS` →
`START_SERVICES`; в 19:13:05 UTC получен `INSTALLED`, receipt автоматически
архивирован. Архивный receipt `status/archive/b094da95….json` содержит
`status=INSTALLED`, `phase=COMPLETE`.

- `installed.json`: `f1a8f412994d743589a5679e9e9664d8985306fd`, 35 миграций.
- PostgreSQL `migrations`: ровно 35 записей; ordered names точно совпали с
  installed и available manifest. Последняя —
  `UserDeletionCleanup1792831700000`.
- `state.json.active`: manifest commit `f1a8f41`; 35 structured migration records,
  их names точно совпали с installed checkpoint.
- `last-status.json`: `INSTALLED`, commit `f1a8f41`, backup ID
  `20261119_191221_bfea6edb`.
- Backend/frontend image revision labels и image IDs соответствуют точной pair
  из проверенного manifest.
- `pending.json`, `request.json`, `current.json`, `archiving.json` отсутствуют.
- 4 контейнера healthy; публичный HTTPS `https://192.168.3.117:18443/` → 200.
- Discovery available = current `f1a8f41`.

## Доступные runtime smoke-проверки

На фактически установленном публичном endpoint:

- `GET /api/v1/admin/users` без credentials → 401 `UNAUTHORIZED`.
- `POST /api/v1/admin/users` без credentials → 401 `UNAUTHORIZED`.
- `POST /api/v1/auth/register` → 403 `REGISTRATION_DISABLED`.
- В отдаваемом сервером frontend JS присутствуют элементы полного UI:
  создание, редактирование, смена пароля, блокировка, реактивация и удаление.

**Не выполнено:** authenticated CRUD/UI smoke с синтетическим пользователем.
Для него нужна существующая административная сессия или учётные данные admin.
Встроенный браузер отклонил self-signed TLS стенда; управление внешним браузером
и desktop accessibility в текущем окружении отключены. Обход аутентификации,
подпись собственного token и прямое создание privileged account не применялись.
Поэтому этот документ не утверждает реальный authenticated UI/E2E успех; полный
CRUD подтверждён PostgreSQL/HTTP regression-тестами и Linux CI, но не живым
administrator workflow на VM120.

## Остаточные границы scope

Persistent admin audit trail и invalidate пользовательских сессий при восстановлении
резервной копии остаются отдельными этапами и в PR #71 не входили.
