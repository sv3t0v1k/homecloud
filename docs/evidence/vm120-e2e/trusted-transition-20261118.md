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
