# Доверенный переход VM120 на 70fe00e: additive-миграции 31→34 — 2026-11-19

Стенд: vm120 (`homecloud-e2e`, `ubuntu@192.168.3.117`), checkout `/home/hs/homecloud-test`,
compose-проект `homecloud-e2e-120`. Владелец: Alex. Оператор: тимлид-агент.

## Цель и результат

Установить TEST-кандидата `70fe00e9ca82c8644678a374ad02d7006472fd4f`
(squash PR #68, контракт additive-миграций) поверх `438fd44` (31 миграция).
**Результат: INSTALLED**, первая реальная установка с выполнением миграций
(31→34) в истории стенда. Цель достигнута после устранения двух отказов.

Артефакт: CI run 44507111092, `test-channel-1`, artifactId 14520790840,
`manifest_sha256 bc727e47ada35b49e241c8c936192bd512c7843c5738cf03fb554e216cf023e4`.

## Предусловия (проверены ~10:40Z)

- installed `438fd44` (31 миграция), checkout HEAD `97c134a`, pending нет,
  `current.json` нет, 4 контейнера healthy, окно admission закрыто.
- PR #68 прошёл независимый review тимлид-агентом по фактическому diff
  (10 файлов, +339/−48) и полный зелёный CI, включая native-recovery.

## Шаг 2: бэкап (10:43:37Z)

`/root/anchor-backup-20261119T104337Z/`: 6 якорей + `anchors.sha256`,
`checkout.head` (97c134a), `docker.ps`, `installed.json`.

## Шаг 3: якоря (10:44–10:46Z)

Батч меняет доверенные `deploy/linux/test-channel.py` и
`deploy/linux/update-install-bridge.py`; из root-якорей затронут только
`homecloud-update-install`. Он установлен из git-blob'а `70fe00e`
(install root:root 0755). Контроль `check_anchor` для всех пяти якорей —
побайтовое совпадение с blob'ами. QUALIFIED-хэши не менялись.

## Шаг 4–5: бейзлайн и синтетика (10:46Z)

- ff-merge checkout `97c134a → 70fe00e`, дерево чистое.
- Discovery опубликовал `available.json`: commit 70fe00e, 34 миграции.
- Верификатор без заявки: STOP (fail-closed, exit=1).

## Попытка 1 (10:47:41 → 10:48:14Z): MANUAL_RECOVERY_REQUIRED на INSTALLER

Dry-run вручную проходил (`INSTALL`, `migration_apply: true`, новые миграции
`AddUserRolesAndSessionVersion1792831400000`,
`RevokeLegacyRefreshTokens1792831500000`,
`NormalizeUserEmails1792831600000`), поэтому отказ был после dry-run-точки.
Traceback по `precheck_source`: **`TEST repository origin mismatch`** —
на стенде `origin` остался со старым именем
`https://github.com/sv3t0v1k/https---github.com-sv3t0v1k-homecloud.git`,
а манифест несёт `sv3t0v1k/homecloud`. `precheck_source` требует точного
совпадения origin с манифестом — отказ по дизайну.

Исправление: `git remote set-url origin https://github.com/sv3t0v1k/homecloud`.
Квитанция сведена: `status/archive/20261119T105139Z-MANUAL_RECOVERY-origin-mismatch.json`.

**Урок для runbook**: после rename репозитория на стенде обновлять `origin`
в `/home/hs/homecloud-test` — иначе любая установка откажет до транзакции.

## Попытка 2 (10:51:55 → 10:53:37Z): INSTALLED

Заявка в inbox с тем же manifestSha256; admission принял; мост и установщик
прошли полную цепочку фаз: VERIFY_TRUST → FETCH_MANIFEST → INSTALLER →
VERIFY_IMAGES → BACKUP → WRITE_REFS → **MIGRATION_APPLY** → START_SERVICES →
SMOKE → COMMIT_STATE → COMPLETE.

- Backend entrypoint выполнил TypeORM `migration:run --transaction all`;
  applied-набор сверен с манифестом после миграционной фазы и после полного
  запуска.
- backup_id `20261119_105252_993335f3` (снимок старой схемы, 31 миграция).
- Квитанция: `status/archive/bc727e47….json` — INSTALLED, phase COMPLETE.

## Пост-проверки (10:53–10:55Z)

- `installed.json`: `70fe00e9…`, 34 миграции — совпадает с манифестом.
- В БД `migrations`: **34** записи.
- `last-status.json`: INSTALLED, backup_id записан.
- 4 контейнера healthy (backend/frontend/ingress обновлены); backend
  healthcheck OK; публичный HTTPS 200.
- Discovery: кандидат = current (commit 70fe00e).
- Окно `homecloud-update-admission.path` закрыто (`disable --now`), inbox пуст.

## Открытые follow-up

1. Миграционные drills из обновлённой процедуры (п. 6.4–6.5): неприменимая
   миграция и SIGKILL в MIGRATION_APPLY — нужны disposable-кандидаты и
   отдельное окно; в этой кампании не выполнялись.
2. Runbook: добавить шаги «скачать новый ingress-образ до заявки» (см.
  кампанию `migration-gate-campaign-20261119.md`) и «обновить origin после
  rename репозитория».
3. Миграция TEST-канала на GitHub Releases (prerelease) — прежний бэклог.
