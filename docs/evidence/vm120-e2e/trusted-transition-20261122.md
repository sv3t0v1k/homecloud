# Доверенный переход VM120 на c153ef2: discovery-фикс — 2026-11-22

Стенд: vm120 (`homecloud-e2e`, `ubuntu@192.168.3.117`), checkout `/home/hs/homecloud-test`,
compose-проект `homecloud-e2e-120`. Владелец: Alex. Оператор: агент по согласию владельца (окно 21:45–22:20 VLAT).

## Цель и результат

Принять как новый доверенный базовый уровень изменение
`deploy/linux/update-host-discover.py` из PR #78 (squash `c153ef2fa0d52f06bb04c8e921c001002fd8c547`):
discovery публикует `sourceGitSha` фактически установленной сборки (из `installed.json`)
вместо HEAD рабочего checkout, кэш `available.json` инвалилидируется по установленному SHA.
**Результат: INSTALLED**, целевые проверки семантики discovery — PASS.

## Контекст перехода

- Переход 21.11 (установка `a25ab63`, PR #77) уже заменил verify/install/archive/admission
  якоря; к моменту начала на хосте расходился **только**
  `/usr/local/sbin/homecloud-update-discover` (старая версия).
- `scripts/`-изменения диапазона `01133dc` вошли в базу доверия переходом 21.11.
- Дифф доверия `a25ab63..c153ef2`: только `deploy/linux/update-host-discover.py`
  (frontend-файлы trusted-деревья не входят).
- Независимый review: дифф прошёл PR-review и полный CI (13 проверок);
  владелец утвердил окно и план перехода.

## Предусловия (проверены)

- Push-прогон `c153ef2`: CI run 45017990400 — success; artifactId 14752746856.
- `pending.json` отсутствует; 4 контейнера healthy; installed `a25ab63` (35 миграций).
- SSH + sudo без пароля — OK.

## Шаг 2: бэкап (11:49:06 UTC)

`/root/anchor-backup-20261122T114906Z/`: 6 якорей + `anchors.sha256`,
`checkout.head` (`a25ab63`), `docker.ps`, `installed.json`.

## Шаг 3: якорь (11:48–11:50 UTC)

Заменён только `homecloud-update-discover`: установлен из git-blob'а `c153ef2`
(`install root:root 0755`), сверка `check_anchor` — побайтовое совпадение.
Проверка синтаксиса целевым python — OK. Остальные пять якорей не тронуты
(сверены с blob'ами `a25ab63` — совпадение подтверждено до и после).

## Шаг 4: бейзлайн

ff-merge checkout `a25ab63 → c153ef2` (дерево чистое). Контейнеры не прерывались.

## Шаг 5: синтетика

- Discovery опубликовал `available.json`: `commit=c153ef2`, `runId=45017990400`,
  35 миграций. **Новое поведение подтверждено:** `sourceGitSha=a25ab63 == installed.gitSha`
  (старый якорь публиковал бы HEAD checkout `c153ef2` → расхождение с installed).
- Верификатор без заявки: STOP, exit=1 (fail-closed).
- Промежуточный отказ таймера в момент перехода (11:48:53) — graceful STOP
  с invalidate, затем успешная републикация; не является дефектом.

## Шаг 6: установка кандидата test-c153ef2

- Операторская разборка 21.11: квитанция INSTALLED (`b71a19b0`) заархивирована
  штатным `homecloud-update-archive`, остаток `inbox/request.json` удалён → NO_JOB.
- Заявка подана через inbox (байт-в-байт формат backend: `homecloud-update-request-v1`,
  `manifestSha256=47a5ac66…4a05c9`, владелец `1001:65533`, mode 0600, tmp+hardlink).
- Admission принял; мост прошёл фазы: VERIFY_TRUST → FETCH_MANIFEST → VERIFY_IMAGES →
  BACKUP → START_SERVICES → (миграции совпали, MIGRATION_APPLY не требовался) →
  SMOKE → COMMIT_STATE → COMPLETE. Квитанция: `status/archive/47a5ac66….json` — INSTALLED.
- `installed.json`: `gitSha=c153ef2`, version `c153ef2`, 35 миграций; в БД 35 записей.

UI-путь не использовался нарочно (операторская заявка), хотя новая семантика
`sourceGitSha` снимает причину его недоступности после ff-merge.

## Целевые проверки семантики discovery

1. **HTTPS:** `https://192.168.3.117:18443/` → 200; 4 контейнера healthy.
2. **Кэш:** повторный запуск discover — кандидат «current»
   (`commit == sourceGitSha == c153ef2`), отказ в перепроверке не зафиксирован.
3. **Fail-closed без installed.json:** временное перемещение `installed.json` →
   discover завершился ошибкой, `available.json` удалён (invalidate);
   после побайтового восстановления кандидат перепубликован.
4. **Отказ до бэкапа:** заявка с `manifestSha256=0000…00` → STOP на VERIFY_TRUST,
   `pending.json` отсутствует, контейнеры и данные нетронуты. STOP-квитанция
   сведена вручную (`archive/20261122T1216Z-STOP-00000000.json`) —
   штатный archiver принимает только INSTALLED; урок сохранён.

## Финальное состояние

- checkout `c153ef2`, installed `c153ef2`, кандидат «current», статус NO_JOB, inbox пуст.
- Все шесть root-якорей побайтово равны helper-байтам checkout.
- Discovery timer `enabled/active`, `AUTO_UPDATE=false`.
- Бэкап перехода: `/root/anchor-backup-20261122T114906Z/`.

## Дополнение: полный UI-цикл на свежем кандидате (23:15–23:32 VLAT)

После влития evidence (PR #79, squash `6235418e`) discovery опубликовал нового
кандидата `test-6235418` (`sourceGitSha=c153ef2 == installed`). Штатный
пользовательский путь подтверждён end-to-end через тот же API-контур, что использует UI:

1. Вход администратора → `GET /updates`: установлен `c153ef2`, доступен
   `test-6235418`, статус `available` — кнопка «Установить» активна.
2. `POST /updates/installations` с `manifestSha256=ee25078c…` → `QUEUED`
   (backend записал заявку в inbox в формате `homecloud-update-request-v1`).
3. Оператор открыл окно (`systemctl enable --now homecloud-update-admission.path`);
   admission принял заявку, установщик прошёл фазы VERIFY_TRUST → FETCH_MANIFEST →
   VERIFY_IMAGES → BACKUP → START_SERVICES → SMOKE → COMMIT_STATE → COMPLETE.
   Квитанция: `status/archive/ee25078c….json` — INSTALLED (13:28:36 UTC).
4. Окно закрыто (`disable --now`), inbox пуст.
5. Пост-проверки: `installed.json = 6235418` (35 миграций), 4 контейнера healthy,
   HTTPS 200; `GET /updates` → статус `current`, `available: null`;
   `installations/current` → `NO_JOB`; discovery: кандидат «current»
   (`commit == sourceGitSha == 6235418`).

Замечание по эксплуатации: `homecloud-update-admission.path` на стенде по умолчанию
выключен (`AUTO_UPDATE=false`), поэтому заявка из UI ожидает открытия операторского
окна — это штатная, а не ошибочная задержка.

## Точки отката

- До установки: якоря из `/root/anchor-backup-20261122T114906Z/` +
  `git reset --hard a25ab63`.
- После установки: только через backup_id из квитанции `47a5ac66…` (recovery-inspect).

## Дополнение: установка test-650264c — отказ BACKUP после смены LOCKED_FILES, сведение и успех (02:40–03:45 VLAT 23.11)

Кандидат `test-650264c` (PR #82, лимиты загрузки 100 GiB) меняет
`docker-compose.project-test.yml` — файл из `LOCKED_FILES`. Установка потребовала
ручной квалификации и выявила неочевидный порядок действий.

1. **Первая заявка — отказ на precheck.** `precheck_source` отказал по
   `LOCKED_FILES`: «operational/Compose Git entry changed; manual qualification
   required» — побайтовое тождество operational/Compose-файлов между текущим и
   целевым коммитами обязательно. Квитанция: `phase=INSTALLER`,
   `MANUAL_RECOVERY_REQUIRED` (16:47:35 UTC) → заархивирована как
   `status/archive/20261122T1647Z-MANUAL_RECOVERY-locked-compose.json`.
   `pending.json` не создавался (отказ до начала транзакции).
2. **Ручная квалификация.** Checkout ff-мержнут на `650264c`, байты
   compose-файлов сверены с Git-блобами (`git show 650264c:<path>`).
3. **Вторая заявка — отказ на BACKUP.** `precheck_source` прошёл
   (current == target), транзакция дошла до фазы BACKUP, но
   `recovery_storage.resolve_storage()` отказал: «backend container does not
   match current Compose configuration». Причина: контейнеры были созданы из
   compose-конфигурации 6235418, а после ff-merge файлы на диске — 650264c;
   config-hash backend разошёлся, и storage fence сработал fail-closed — как и
   задумано. Автоматический откат (`recover_before_start`) корректно отказал из-за
   живого maintenance-маркера → `MANUAL_RECOVERY_REQUIRED`, `backup_id=null`
   (backup.sh пал на `recovery_storage_resolve`, до lock/staging — артефактов нет).
   Квитанция: `phase=BACKUP` (17:08:31 UTC).
4. **Операторское сведение** (прецедент `manual-reconciled-*`):
   - evidence сведено в `.runtime/test-channel/manual-reconciled-20261122T1734Z-53466f4f/`
     (pending.json, last-status.json, bridge-receipt.json);
   - идентичность маркера сверена с `pending.json.backup_maintenance`
     (st_dev/st_ino 64512/843747, root:root 0600) и маркер удалён;
   - `pending.json` удалён; `last-status.json` восстановлен в засвидетельствованное
     INSTALLED 13:28 (commit 6235418, backup_id `20261122_132752_01befae0`,
     manifest `ee25078c…`; поле `at` взято из bridge-квитанции — исходное значение
     установщика было перезаписано отказом);
   - bridge-квитанция заархивирована как
     `status/archive/20261122T1734Z-MANUAL_RECOVERY-backup-storage-drift.json` → `NO_JOB`;
   - `homecloud-test-launcher start`: compose пересоздал backend/frontend/ingress
     под конфигурацию 650264c (образы — прежние закреплённые из runtime.env),
     config-hash сошёлся, `resolve_storage` → OK, 4 контейнера healthy, HTTPS 200.
5. **Третья заявка — успех.** `POST /updates/installations`
   (`manifestSha256=53466f4f…`) → QUEUED → фазы VERIFY_TRUST → FETCH_MANIFEST →
   VERIFY_IMAGES → BACKUP → START_SERVICES → SMOKE → COMMIT_STATE → COMPLETE.
   Квитанция: `status/archive/53466f4f….json` — INSTALLED (17:40:17 UTC),
   backup_id `20261122_173933_4bb641e5`. Окно admission закрыто.
6. **Пост-проверки:** `installed.json = 650264c`, `state.json.active = 650264c`;
   `GET /updates` → `current`, `available: null`; 4 контейнера healthy; HTTPS 200;
   `GET /api/v1/uploads/limits` → `maxFileBytes = maxActiveBytes =
   107374182400` (100 GiB), `effectiveMaxFileBytes = 107374182400`.

**Правило на будущее (LOCKED_FILES):** при изменении operational/Compose-файлов
автоматическая установка штатно отказывает на precheck. Ручная квалификация =
ff-merge checkout **и немедленное пересоздание контейнеров** из новой
конфигурации (`homecloud-test-launcher start`), иначе backup-фаза следующей
установки откажет по config-hash (storage fence требует тождества
закреплённого контейнера и текущего Compose-конфига). Сведение отказа на BACKUP
с `backup_id=null` допустимо только после проверки: отказ произошёл до создания
артефактов (нет `.staging`/`.backup.lock`), идентичность маркера сошлась с
`pending.json`, данные и state.json соответствуют прежнему checkpoints.

**Напоминание по ёмкости:** честная загрузка 100 ГБ требует расширения диска sdc
в Proxmox — на момент установки свободно ~90 GiB из 96 GiB.
