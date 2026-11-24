# Доверенный переход VM120 после trusted-батча — кампания 2026-11-18

Стенд: vm120 (`homecloud-e2e`, `ubuntu@192.168.3.117`), checkout `/home/hs/homecloud-test`,
compose-проект `homecloud-e2e-120`. Владелец: Alex. Оператор: тимлид-агент.

## Исходное состояние (зафиксировано 08:53:51Z)

- Бэкап якорей: `/root/anchor-backup-20261118T085351Z/` (6 файлов + `anchors.sha256`,
  `checkout.head`, `docker.ps`, `installed.json`).
- Checkout HEAD: `0452caa00858a4f801e723575bf0b1b8860ee7`, дерево чистое.
- Установлено: `0452caa` (формат `homecloud-installed-test-v1`, 31 миграция).
- Контейнеры: `homecloud-e2e-120-{ingress,frontend,backend,db}` — все healthy.
- Окно: `homecloud-update-admission.path` active; незавершённой транзакции нет.
- Хэши якорей до замены:
  - `homecloud-update-verify` `12947a3feb67…`
  - `homecloud-update-install` `f291d74b83e9…`
  - `homecloud-update-archive` `ae7e8613b6b7…`
  - `homecloud-update-discover` `c500c17ca6e5…`
  - `update-admission.py` `51cda835a4bb…` (в батч не менялся)
  - `homecloud-test-launcher` `f8199f84ff58…` (root-boundary, в батч не входил)

## Шаг 3–4: якоря и бейзлайн (08:54–08:56Z)

- Базовый коммит перехода: `489a2432fecf30c50a0965847216954c3d678fc4` (squash PR #63).
- 5 якорей установлены из git-blob'ов коммита; `check_anchor` — все OK;
  метаданные `root:root`, regular files, без ACL.
- ff-merge checkout `0452caa → 489a2432` чистый; контейнеры не тронуты.

## Шаг 5: синтетика (08:56–08:58Z)

- Discovery новым якорем опубликовал `available.json`: `commit 489a2432`,
  `artifactId 14412070746`, `runId 44268587239`, дайджесты backend/frontend
  совпали с манифестом.
- Верификатор без заявки: `STOP: host evidence verification refused`, exit=1 (fail-closed).

## Шаг 6.1: установка кандидата test-489a243 (09:27:22 → 09:29:40Z)

Инициирование — записью заявки в inbox (см. «Найденные ограничения» ниже):
`/var/lib/homecloud-update/inbox/request.json`, владелец `1001:65533`, mode 600,
атомарно (tmp + hardlink), формат `homecloud-update-request-v1`.

Фазы: `VERIFY_TRUST → FETCH_MANIFEST → INSTALLER → VERIFY_IMAGES → … →
WRITE_REFS → START_SERVICES → COMPLETE/INSTALLED`.

- Образы pulled строго по дайджестам манифеста
  (`34e11ead…` backend, `5e413aa7…` frontend).
- Результат: `status INSTALLED`, `backup_id 20261118_092855_02c2bf0f`,
  `last-status.json` (`.runtime/test-channel/`).
- Пост-состояние: `installed.json` = `489a2432` (31 миграция), checkout HEAD =
  `489a2432` (bridge передвинул бейзлайн штатно), 4 контейнера healthy,
  публичный HTTPS 200, `available.json` перепубликован (кандидат «current»).

## Шаг 6.2: drill отказа до бэкапа (09:36:48 → 09:36:59Z)

Заявка с несуществующим `manifestSha256` (64 нуля).

- Результат: `VERIFY_TRUST → STOP` за 11 секунд. Бэкап не начинался,
  `pending.json` не появился, контейнеры и `installed 489a243` не тронуты.
- Квитанция сведена: `status/archive/20261118T093659Z-STOP-00000000.json`.

## Drill 6.3: попытка переустановки текущей версии (09:47:16 → 09:48:00Z)

- Установщик для того же коммита печатает `SKIP: exact TEST source already installed`;
  мост трактует SKIP как `installer refused or ambiguous result` →
  `MANUAL_RECOVERY_REQUIRED` на фазе `INSTALLER`, `pending.json` не создавался.
- Квитанция сведена: `status/archive/20261118T094759Z-MANUAL_RECOVERY-skip-reinstall.json`.
- Вывод: SIGKILL-drill требует кандидата с новым коммитом; см. follow-up задачу.

## Найденные ограничения (фиксируются в документах)

1. **Backend-гейт переходного состояния.** `parseHostTestCandidate` требует
   `sourceGitSha == installed.gitSha`; после ff-merge бейзлайна до установки
   это невыполнимо → `check_unavailable`, `submit()` отказывает (409). UI/API
   инициирование в момент перехода невозможно по дизайну; заявка подаётся
   записью в inbox (владелец `1001:65533`, mode 600). В штатном потоке
   (installed == checkout HEAD) гейт пропускает — пользовательский цикл
   самообслуживания через UI не затронут.
2. **SKIP ≠ INSTALLED.** Повторная установка того же коммита отказывается
   мостом как ambiguous. Для drill'а SIGKILL нужен свежий кандидат.
3. **Admission.path** при частых триггерах может уйти в `failed` (rate limit);
  лечится `systemctl reset-failed` + повторный запуск.

## Точки отката

- До шага 6: якоря из `/root/anchor-backup-20261118T085351Z/` + `reset --hard 0452caa`.
- После 6.1: восстановление из `backup_id 20261118_092855_02c2bf0f` (recovery-inspect).

## Вечернее продолжение: drill SIGKILL, доведение до 438fd44, rename (12:30–13:20Z)

### Drill SIGKILL на START_SERVICES (10:54Z)

- Заявка на `438fd44` (manifest `d546f619…`, `artifactId 14420191250`); установка
  прервана SIGKILL на фазе `START_SERVICES` после бэкапа `20261118_105439_ce1928df`.
- `recovery-inspect` корректен; сверка данных с базовой линией совпала
  (БД: 1 пользователь / 5 файлов / 2 папки; контрольные суммы storage совпали).
- Транзакция сведена в `.runtime/test-channel/manual-reconciled-20261118T110231Z-ce1928df/`.

### Блокер GitHub 401 и его разрешение

- Вторая попытка `438fd44` упала на `VERIFY_TRUST`: GitHub стал требовать токен
  для скачивания Actions artifacts (анонимно — 401; лимит rate limit не причина).
- Разрешение: токен оператора разложен на стенде в `/etc/homecloud-test/update-worker.env`
  (root:root, 0600); юниты discovery/install подхватывают его через `EnvironmentFile`.
  Discovery с токеном зелёный; скачивание артефакта проверено отдельно.

### Скрытый дрифт после drill'а и его устранение (12:34–12:56Z)

- Симптом: мост отказал на `INSTALLER` (`runtime image refs differ from checkpoint`).
- Причина: прерванный на START_SERVICES drill оставил `runtime.env` и контейнеры
  backend/frontend на образах кандидата `438fd44`, тогда как чекпоинт —
  `489a243` (`34e11ead…` / `5e413aa7…`). Preflight-защита от дрейфа
  сработала штатно.
- Устранение (оператор, вне механики установщика): бэкап
  `.runtime/maintenance/runtime.env.drift-backup-20261118T123800Z`; откат
  `RELEASE_*_IMAGE` в `.runtime/runtime.env` до чекпоинтных дайджестов;
  пересоздание контейнеров backend/frontend из чекпоинтных образов
  (`compose create`, без запуска). Preflight (`dry-run`) после этого: `decision INSTALL`.
- Повторная заявка: сведена квитанция `MANUAL_RECOVERY_REQUIRED` (прежде чем
  подавать новую — admission требует отсутствия квитанции), заявка подана
  заново через inbox.

### Финальная установка test-438fd44 (12:58 → 13:08Z)

- `VERIFY_TRUST → FETCH_MANIFEST → INSTALLER → … → INSTALLED` штатно.
- Квитанция INSTALLED в `status/archive/d546f6196d5074563c3dc1aa7edd69bcee6e79c8ade093024bd2cc728fa141ba.json`.
- `installed.json` = `438fd44`; checkout HEAD = `438fd44`.
- Пост-проверки: 4 контейнера healthy, публичный HTTPS 200, зонд readiness
  бэкенда OK.

### Rename репозитория и закрытие окна (13:10–13:20Z)

- Репозиторий переименован в `sv3t0v1k/homecloud` (старый URL перенаправляется
  GitHub; discovery на стенде с fallback-именем работает — проверено повторным запуском).
- `homecloud-update-admission.path` `disable --now` — окно Trusted Transition закрыто;
  обновления стенда далее только через UI/API, как у обычного пользователя.
  `homecloud-update-discover.timer` остаётся активен (публикация `available.json`).
- Итоговое состояние: `installed 438fd44` == HEAD ветки test, HTTPS 200, окно закрыто.

### Остаточный долг (фиксируется в бэклог)

- Fallback-имя `sv3t0v1k/https---github.com-sv3t0v1k-homecloud` остаётся в
  `deploy/linux/update_source.py`, `deploy/linux/update-host-discover.py`,
  `deploy/linux/update_evidence.py`. Работает через redirect GitHub; замена на
  `sv3t0v1k/homecloud` потребует обновления QUALIFIED-хэшей якорей — входит
  в задачу миграции TEST-канала на GitHub Releases (prerelease).
- Токен в `/etc/homecloud-test/update-worker.env` — личный токен оператора;
  отозвать/заменить после миграции на Releases-схему.
- Поведение «прерванная на START_SERVICES установка оставляет дрифт env/контейнеров»
  задокументировано здесь; автоматическое восстановление — отдельный дизайн-вопрос.
