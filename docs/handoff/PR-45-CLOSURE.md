# HomeCloud — технический handoff: завершение PR #45

**Актуальный checkpoint (15 ноября 2026): NOT READY, раздел37; installed TEST plan — раздел35. Все6 source commits опубликованы ordinary push, HEAD c1673d7, PR DRAFT. Actual native AMD64/OCI run43608761566 завершился FAIL: native product primitives/maintenance/copy прошли, но выявлены CI fixture и security baseline failures. Подготовлены12-path fixes двумя группами, текущий manifest118. Для Git commits требуется обычный Terminal; normal push из sandbox уже подтверждён. Старый publication helper не повторять. Разрешение на последующие commits/push сохраняется; B01/B02 OPEN; merge/deploy/release запрещены.**

**Дата:** 12 ноября 2026 г.
**Проект:** HomeCloud
**Репозиторий:** `sv3t0v1k/https---github.com-sv3t0v1k-HomeCloud`
**Рабочая директория:** `~/Desktop/HomeCloud`
**Рабочая ветка:** `миниатюры-файлов-v1`
**Последний подтверждённый HEAD:** `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`
**PR:** #45 → `test`
**Base предыдущего security review:** `85578280b40d485c2765e961e6ec4f591d43f02c`

---

## 1. Главная задача

Завершить весь текущий цикл исправлений PR #45, сохранить достигнутые результаты, устранить оставшиеся дефекты, проверить безопасность и работоспособность HomeCloud на реальных Linux/Docker/PostgreSQL сценариях.

Не ограничиваться последней ошибкой тестов. Требуется довести текущую работу до полностью проверенного состояния, пригодного для финального независимого security review и последующей интеграции в `test`.

Первоначальная задача PR — миниатюры файлов и функциональное завершение файлового менеджера. В ходе независимых security review обнаружены критические проблемы безопасности копирования файлов, согласованности PostgreSQL и файлового хранилища, аварийного восстановления, конкурирующих writer-процессов.

Исправления существенно расширились до инфраструктуры maintenance, Backup/Restore и TEST-обновлений, поскольку без них невозможно гарантировать корректность recovery при аварийном завершении процессов.

**B01/B02 остаются открытыми BLOCKER.** Не считать их закрытыми только на основании прохождения отдельных unit-тестов.

---

## 2. Обязательные правила работы

1. Единственный рабочий репозиторий: `~/Desktop/HomeCloud` на MacBook.
2. Запрещено создавать дополнительные Git worktree, клоны и рабочие копии проекта в `/tmp`, `.codex`, `.kilo` или других каталогах.
3. Работать в текущей ветке `миниатюры-файлов-v1`. Не создавать другую ветку для этой задачи.
4. Перед работой проверить текущую ветку, HEAD, Git status, staged changes, полный tracked diff и новые untracked файлы.
5. Все текущие незакоммиченные изменения считать важной работой, выполненной предыдущими этапами. Не удалять, не откатывать и не заменять их старой реализацией без конкретного технического обоснования.
6. Запрещены `git reset --hard`, `git clean -fd`, force-push и другие разрушительные Git-операции.
7. Не затрагивать посторонние изменения и файлы.
8. Не читать, публиковать или включать реальные секреты в логи, тестовые артефакты и коммиты.
9. Не отключать существующие security gates для прохождения тестов.
10. Не использовать реальный сервер HomeCloud, реальные данные пользователей или production Docker volumes для деструктивных тестов.
11. Никаких автоматических deploy, release, установки обновлений или merge.
12. Коммиты — небольшие, логически завершённые, на русском языке.
13. По завершении подготовить отчёт о работе и доказательства проверок. Не объявлять PASS для непроверенных сценариев.

**Важно:** временные файлы изолированного Docker-стенда, тестовые данные и disposable ext4-тома допустимы. Запрет на дополнительные рабочие копии относится к исходному Git-репозиторию.

---

## 3. Первый этап — восстановление текущего состояния

Немедленно проверить:

```bash
cd ~/Desktop/HomeCloud
git branch --show-current
git rev-parse HEAD
git status --short
git diff --stat
git diff --check
git diff --cached
git ls-files --others --exclude-standard
```

Самостоятельно прочитать:

- Полный текущий Git diff.
- Все новые файлы, относящиеся к B01/B02.
- Документацию проекта, AGENTS.md и применимые локальные инструкции.
- Текущий PR #45 и последние независимые review findings, если доступны.
- Связанные исходники, тесты, конфигурацию CI и Docker Compose.

Не ограничиваться содержимым последнего опубликованного HEAD: значительная часть исправлений существует только в локальном рабочем дереве.

Предыдущие отчёты и этот handoff — контекст и ориентир, но не замена самостоятельной проверки исходников.

---

## 4. Текущая точка остановки: исправить первой

### Последний прогон

В `scripts/recovery_storage.py` добавлены:

- `release_service_identities()`;
- `wait_release_services()`;
- `restart_existing_services()`;
- поддержка `release_service_inventory(snapshot, require_ready=False)`;
- CLI action `restart-existing`.

В `scripts/restore.sh` старый `docker compose start --wait` заменён на вызов нового механизма.

Создан:

`scripts/ci/test-recovery-restart.py`

Последний запуск показал:

- 7 тестов выполнено;
- 4 PASS;
- 3 ERROR.

Падают:

1. `test_plain_start_preserves_original_containers`;
2. `test_restore_captures_existing_identity`;
3. `test_waits_for_health`.

Все три завершаются:

`recovery_storage.StorageError: RELEASE containers changed during restart`

В этих тестах ожидаемая и фактическая identity формируются из одного набора контейнеров, поэтому ошибка требует проверки самой реализации.

### Приоритетная гипотеза

При вставке новых функций перед `def release_backup_window()` существующий декоратор `@contextmanager` мог остаться над новой функцией `release_service_identities()`.

Это объяснило бы одновременно:

- возврат объекта контекстного менеджера вместо словаря;
- ложное несовпадение идентичности;
- возможную потерю contextmanager-декоратора у `release_backup_window()`.

**Это гипотеза, а не подтверждённый диагноз.** Проверить исходник и AST. Исправить точную причину и добавить регрессию, проверяющую реальные типы возвращаемых значений и контракт контекстного менеджера.

Не ослаблять сравнение container ID/image ID ради зелёных тестов.

Последняя команда остановилась после падения этих тестов. Остальные регрессии, обновление E2E runtime image и новый полный E2E не выполнялись.

---

## 5. Исходная архитектура B01/B02

### B01 — согласованность копирования и аварийное восстановление

Копирование файлов не должно создавать:

- потерянные физические файлы;
- записи PostgreSQL без соответствующих объектов storage;
- ошибочное освобождение квоты;
- повторную публикацию после неопределённого результата COMMIT;
- удаление объекта, который фактически уже был успешно опубликован;
- обход ограничений владельца и доступа к удалённым объектам.

В текущих исправлениях введены:

- durable file copy admission;
- журнал `file_copy_operations`;
- состояния `reserved`, `cleanup_required`, `committed`, `released`;
- уникальная активная операция на пользователя;
- привязка операции к storage location и relative object key;
- cleanup claim;
- отдельный offline recovery CLI;
- проверка PostgreSQL journal перед Backup/Restore;
- транзакционная публикация metadata и обработка ambiguous commit.

Миграция:

`backend/src/migrations/1792831300000-FileCopyAdmission.ts`

Имя:

`FileCopyAdmission1792831300000`

Связанные новые файлы:

- `backend/src/files/file-copy-admission.service.ts`
- `backend/src/files/file-copy-admission.postgres.spec.ts`
- `backend/src/files/file-copy-offline-recovery.ts`
- `backend/src/files/file-copy-recovery-cli.ts`

Не заменять этот механизм простым try/catch, удалением временного файла или best-effort cleanup.

### B02 — единая граница записи storage

Любой процесс, способный писать в постоянное хранилище, должен подчиняться общей границе writer fencing.

Реализованы:

- secure copy на файловых дескрипторах;
- Linux descriptor-relative операции;
- защита от symlink/TOCTOU и подмены mount/root;
- проверка идентичности storage;
- native flock корневого каталога;
- наследование root fence дочерними процессами;
- supervisor для API, миграций и operator CLI;
- maintenance inhibitor, запрещающий обычный запуск writer во время recovery;
- независимая проверка отсутствия других writers.

Ключевые файлы:

- `backend/src/storage/storage.service.ts`
- `backend/src/uploads/secure-filesystem.ts`
- `backend/src/uploads/inherited-root-fence.ts`
- `backend/docker/copy-root-fence-supervisor.cjs`
- `backend/docker/entrypoint.sh`
- `backend/src/main.ts`
- `backend/src/api-bootstrap.ts`

Linux deployment:

- `deploy/linux/startup-gate.sh`
- `deploy/linux/preflight.py`
- `deploy/linux/maintenance-inhibit.py`
- `deploy/linux/maintenance-window.py`
- `deploy/linux/storage-writer-fence.py`
- `deploy/linux/recover-copy.py`

Обязательно проверить, что ни один writer не может обойти startup gate, root flock или maintenance inhibitor через альтернативную команду, рестарт контейнера, Compose overlay, operator CLI или migration path.

---

## 6. Уже выполненные исправления: Backend

В текущем рабочем дереве реализованы и тестировались следующие направления.

### Secure copy

- Копирование через закреплённые файловые дескрипторы.
- Проверка источника и целевого пути.
- Защита от подмены root во время операции.
- Cancellation, ограничения параллельных операций.
- Корректный lifecycle дескрипторов и освобождение ресурсов.
- Интеграция с FilesService.
- Обработка неопределённого результата транзакции.
- Регрессионные тесты Linux и PostgreSQL.
- Исправления benchmark runner.

### Durable copy admission

- Транзакционная запись операции.
- Сериализация конкурирующих операций пользователя.
- Корректное резервирование квоты.
- Сохранение recovery evidence при аварии.
- Запрет небезопасного автоматического удаления объекта.
- Offline recovery только под maintenance и fencing.

### Entrypoint и API

- Проверка inherited root fence выполняется до импорта AppModule/ConfigModule.
- Bootstrap перенесён в `api-bootstrap.ts`.
- Supervisor удерживает root flock на протяжении жизненного цикла writer.
- Дочерний процесс наследует fence, включая сценарий аварийной гибели родителя.
- Для restore migration предусмотрен отдельный ограниченный режим запуска.

Существующие тесты должны проверять реальные Linux-системные вызовы, а не только mocks.

---

## 7. Уже выполненные исправления: Backup

Файлы:

- `scripts/backup.sh`
- `scripts/backup-production.py`
- `scripts/recovery_storage.py`
- `scripts/recovery-pending.sql`
- `scripts/recovery-config.sh`
- `scripts/recovery-storage.sh`

Реализовано:

1. Backup только через подтверждённый локальный Linux Docker daemon.
2. Проверка canonical root-owned maintenance paths.
3. Проверка точных container ID, image ID, project labels и bind mount identity.
4. Проверка других writable mounts, включая пересечения родительских/дочерних каталогов.
5. Проверка остановленного backend.
6. Эксклюзивный root flock, удерживаемый `backup.sh` через FD 9.
7. Проверка inherited lock и независимым contender-процессом.
8. Maintenance inhibitor создаётся до остановки writers.
9. PostgreSQL остаётся доступным для pg_dump.
10. Backup staging, SHA256 для дампа и архива, metadata и sidecar.
11. Публикация только проверенных артефактов.
12. Проверка pending journal и отсутствия staging/swap перед завершением.
13. RELEASE operation lock, общий с Restore.
14. Перезапуск только существующего набора контейнеров без pull/recreate.

### Важный подтверждённый результат

В реальном Linux Docker-стенде уже успешно выполнены:

- регистрация тестового пользователя;
- выдача тестовой квоты;
- загрузка файла `before-backup.txt` через настоящий API;
- остановка writers;
- acquisition эксклюзивного backup fence;
- PostgreSQL dump;
- storage archive;
- валидация артефактов;
- SHA256;
- атомарная публикация четырёх backup-файлов.

Реальный backup ID:

`20261112_101519_512e1ec9`

Событие:

`backup_completed`, `exit_code: 0`

Но `release_backup_window()` после успешного backup завершился ошибкой повторного запуска контейнеров.

Поэтому:

**Создание backup — подтверждено. Полный lifecycle Backup с успешным restart — ещё нет.**

---

## 8. Уже выполненные исправления: Restore

Новые файлы:

- `scripts/restore_storage.py`
- `scripts/restore_maintenance.py`
- `scripts/ci/test-restore-storage-fence.py`
- `scripts/ci/test-restore-storage-linux.py`
- `scripts/ci/test-restore-maintenance.py`

### Storage restore

- Проверка архива и SHA256.
- Запрет traversal, ссылок, дубликатов и недопустимых имён.
- Извлечение в отдельный staging.
- Descriptor-relative работа с файловой системой.
- Закрепление identity корня.
- Проверка количества файлов и точной структуры.
- Сохранение старого дерева в swap.
- Удержание swap при ошибках.
- Новая `.tmp` с UID/GID `1001:65533`, mode `0700`.
- Рекурсивное удаление проверенного swap через pinned descriptors без следования symlink.
- Совместимость с Python 3.9: не использовать неподдерживаемый `shutil.rmtree(dir_fd=...)`.

### Restore maintenance lifecycle

Введён durable restore receipt:

`restore.pending.json`

Основные checkpoint:

- `INHIBITED`;
- `WRITERS_STOPPED`;
- `ROOT_FENCED`;
- `DB_RESTORED`;
- `STORAGE_SWITCHED`;
- `MIGRATION_RUNNING`;
- `MIGRATED`;
- `POST_MIGRATION_FENCED`;
- `RECONCILED`;
- `READY`;
- `RESTART_FAILED`.

Принцип:

- operation lock удерживается на протяжении операции;
- inhibitor запрещает обычный запуск backend;
- root fence подтверждает эксклюзивную запись;
- PostgreSQL restore выполняется одной транзакцией;
- старые данные остаются в swap до проверки;
- специальный migration permit разрешает только точную команду миграции;
- после миграции вновь захватывается root fence;
- pending journal и reconciliation должны пройти;
- только после проверки допускается normal restart;
- HTTP readiness обязателен;
- receipt удаляется только после подтверждения завершения.

Restore failure должен сохранять доказательства и безопасное состояние для последующего ручного или штатного восстановления.

### PostgreSQL

Destructive SQL restore выполнен через `psql --single-transaction` с `ON_ERROR_STOP=1`.

`DROP SCHEMA public CASCADE; CREATE SCHEMA public;` и восстановление dump находятся в одной транзакции.

Подтверждено на реальном PostgreSQL 16:

- invalid restore откатывает старую схему и данные;
- valid restore успешно заменяет данные.

### Миграции

Историческая схема: 15 таблиц / 30 миграций.

Текущая ожидаемая схема: 17 таблиц / 31 миграция, последняя:

`1792831300000:FileCopyAdmission1792831300000`

Сверить актуальные исходники, миграции и ожидаемые schema checks; не подгонять fixture под неправильную схему.

---

## 9. Уже выполненные исправления: TEST update lifecycle

Файлы:

- `deploy/linux/test-channel.py`
- `deploy/linux/project-test.sh`
- `deploy/linux/preflight.py`
- `docker-compose.project-test.yml`
- `docker-compose.project-test-updates.yml`
- `scripts/ci/test-test-channel.py`
- `scripts/ci/test-update-preflight.py`

TEST backup integration теперь включает:

- inhibitor до остановки writers;
- удержание существующего install lock;
- durable pending BACKUP receipt;
- backup ID и marker inode;
- проверку завершения под inherited operation lock;
- отказ при unresolved pending journal;
- проверку staging/swap и других writers;
- точное снятие своего marker;
- запрет автоматического rollback поверх активного maintenance.

Не нарушать ранее принятый trust boundary:

- доверенные `deploy`-файлы;
- root-owned anchors;
- pinned helpers;
- проверка Git object integrity;
- защита Compose overlays;
- source compatibility policy;
- запрет небезопасного обхода immutable deploy-контракта.

Не переносить изменения в `main` и не публиковать RELEASE.

---

## 10. Известная проблема Docker Compose

Реальный E2E runtime использует:

`Docker Compose v2.33.0`

В этой версии команда `docker compose start --wait` недоступна.

Необходимая совместимость:

- `docker compose start backend frontend ingress`;
- отдельное bounded ожидание readiness;
- проверка точных container ID и image ID;
- проверка состояния db/backend/frontend/ingress;
- проверка backend storage identity;
- сохранение HTTP readiness gate после Restore;
- отказ при unhealthy, timeout, missing/replaced container, изменении image или inspection failure.

**Запрещено решать проблему заменой `start` на `up`, если это допускает recreate или pull.**

Последние найденные точки:

- `scripts/recovery_storage.py` — RELEASE Backup;
- `scripts/restore.sh` — Restore;
- `deploy/linux/test-channel.py` — TEST restart;
- `scripts/ci/test-test-channel.py` — соответствующее ожидание теста.

Backup и Restore частично исправлены, но новая реализация ещё не прошла регрессии.

TEST пока использует старый `start --wait` и требует устранения.

Дополнительно проверить минимально поддерживаемую версию Compose, фактически используемые версии в CI и deployment, а также соответствие всех операций документированному контракту.

---

## 11. Обязательный аудит оставшихся рисков

Ниже перечислены известные или вероятные слабые места. Самостоятельно подтвердить каждое по текущим исходникам. Не считать гипотезы автоматически установленными дефектами.

### 11.1. Restore staging до изменения PostgreSQL

Проверить, что весь storage archive проходит безопасную валидацию и staging до первого destructive изменения БД.

Если malformed archive, duplicate path, forbidden entry, неверный count или ошибка extraction могут обнаружиться только после SQL restore — исправить.

Добавить durable checkpoint для staging, привязанный к digest, file count и identity подготовленного дерева.

Проверить crash recovery до и после staging.

### 11.2. Maintenance admission failure

Проверить сценарий, когда `begin()` уже создал inhibitor/receipt, но завершился ошибкой до установки shell-переменной `RESTORE_ADMITTED`.

Cleanup не должен оставлять writers в неопределённом состоянии или терять факт начатой maintenance.

Проверить отказ остановки одного из сервисов, частично выполненный stop, SIGKILL и повторный запуск.

### 11.3. Cleanup swap и финальные проверки

Проверить, что irreversible удаление старого swap выполняется только после всех обязательных проверок данных.

В текущей реализации `complete_restore()` часть финальных проверок выполняет после удаления swap.

Выяснить, может ли последующий отказ оставить систему без необходимого recovery evidence или возможности безопасного продолжения.

Исправить порядок операций и checkpoint при необходимости.

### 11.4. READY checkpoint и restart

Проверить окно после снятия inhibitor, но до подтверждения restart и удаления receipt.

Необходимо исключить конфликтующие Backup/Restore/Update при незавершённом READY checkpoint.

Проверить:

- аварийное завершение между clear marker и restart;
- падение backend во время restart;
- частичный restart frontend/ingress;
- сохранность receipt;
- восстановление inhibitor;
- повторную попытку завершения;
- невозможность ошибочного PASS.

### 11.5. Restore migration permit

Текущий режим проверяет:

- точный token;
- root-owned marker;
- root-owned private permit;
- точную команду миграции.

Дополнительно проверить привязку permit к identity конкретного maintenance inhibitor.

Старый permit не должен стать действительным при создании нового inhibitor.

Проверить marker substitution, stale permit, wrong token, wrong command, multiple permits, symlink, ownership/mode/nlink и аварийные сценарии.

При необходимости связать permit с marker dev/ino и operation receipt. Учесть точность Linux inode значений и Node BigInt.

Не допускать произвольный запуск Node, API или другой команды через migration authorization.

### 11.6. Offline copy recovery

Проверить `deploy/linux/recover-copy.py` и backend recovery CLI.

Подтвердить:

- общую operation lock;
- root fence;
- отсутствие всех посторонних writers;
- точный storage bind;
- правильный image;
- отсутствие активного конфликтующего restore/backup;
- безопасность при неопределённом COMMIT;
- отсутствие удаления объектов, уже опубликованных в БД;
- возможность безопасного ручного восстановления после аварии.

### 11.7. RELEASE backup completion

Проверить полный lifecycle:

- capture;
- artifact validation;
- independent restore validation, где это предусмотрено контрактом;
- completion;
- снятие inhibitor;
- restart;
- encrypted backup publication.

Проверить, что `backup-production.py` передаёт корректную resolved configuration всем subprocess.

Сырой `backup.sh` не должен использовать чужую maintenance в обход operation lock или конфликтовать с Restore.

Убедиться, что все RELEASE операции используют один согласованный operation lock.

### 11.8. Физическая storage identity

Не путать два независимых механизма:

1. Startup disk gate: UUID, ext4/xfs, mountinfo, root ownership, внешний `.homecloud-backend` marker.
2. Application storage registry: внутренний `.homecloud-storage-identity` в `/storage`, точный mountpoint, inode, uid, mode, marker fingerprint.

Оба должны работать.

Проверить nested mounts, bind aliases, root replacement, symlink, stale mount, неверный UUID и отсутствие marker.

Проверить сохранение корректного identity marker при Backup/Restore. Не считать тестовый loopback-диск доказательством production physical-disk topology.

### 11.9. Restart helper

Проверить новую общую реализацию дополнительно на:

- декораторы и реальные типы;
- bounded deadline, включая таймаут Docker inspect;
- проверку identity до запуска, а не только после;
- замену frontend/ingress во время ожидания;
- stopped/restarting/paused/dead container;
- отсутствие healthcheck там, где он обязателен;
- unhealthy vs transient starting;
- неизменность точного набора контейнеров;
- невозможность обхода readiness.

Сравнение строк исключений для определения transient readiness не должно скрывать неожиданные structural/identity ошибки.

### 11.10. Trust boundary и CI

Проверить включение всех новых security-critical файлов и тестов в существующие защитные механизмы.

Особое внимание:

- trusted file inventories;
- `contract.FILES` / `LOCKED_FILES`;
- installer и host verifier;
- неизменность deploy trust anchors;
- Compose policy;
- CI security qualification;
- source compatibility;
- test exclusions;
- реальное исполнение Linux/PostgreSQL тестов.

Никакого исключения security-критичных тестов ради зелёного CI.

---

## 12. Подтверждённые результаты предыдущих прогонов

Эти результаты зафиксированы в предыдущих терминальных отчётах. Они относятся к соответствующим этапам изменений, а не гарантируют PASS финального рабочего дерева.

| Проверка | Результат |
|---|---|
| Ранний полный набор backend | 112 suites / 1566 tests PASS |
| Первоначальные maintenance/TEST/fencing регрессии | 179 PASS |
| Backup fencing, первый этап | 91 PASS |
| TEST backup completion | 106 выполнений PASS |
| RELEASE backup lifecycle, ранние регрессии | 132 PASS, 1 skip |
| Descriptor-relative storage restore | 71 PASS |
| Restore migration admission | 78 PASS |
| Restore maintenance lifecycle | 98 PASS |
| Restore migration orchestration | 69 PASS |
| Restore integration после исправления Python 3.9 | 125 PASS |
| Реальный Linux restore crash/fence | 2/2 PASS |
| Реальный Linux backup fence | 30/30 PASS |
| Реальный PostgreSQL transactional restore | 2/2 PASS |
| Реальный production startup disk gate | PASS |
| Реальный production backend startup | PASS |
| Реальный API register/login/upload | PASS |
| Реальный Backup capture/publication | PASS |
| Restart после Backup | FAIL: Compose compatibility |
| Последняя новая restart regression | 4 PASS / 3 ERROR |
| Полный Backup → Restore → verification | НЕ ЗАВЕРШЁН |

Эти результаты нельзя складывать в единое количество уникальных тестов: разные прогоны частично повторяют одни и те же suites.

Известные предупреждения:

- около 20 backend ESLint warnings `jest/expect-expect`;
- Node warning `MODULE_TYPELESS_PACKAGE_JSON` для eslint config;
- cgroup warnings в nested Docker daemon.

Не добавлять `"type": "module"` в backend/package.json без проверки последствий для CommonJS, TypeORM, entrypoint и сборки.

`age`/`age-keygen` ранее отсутствовали на Mac. Полный encrypted backup suite не подтверждён. Не скрывать этот skip — обеспечить подходящую среду или явно зафиксировать незавершённую проверку.

---

## 13. Реальный E2E-стенд уже существует

Не создавать стенд заново без необходимости.

Использовать:

`scripts/ci/test-restore-e2e-local.sh`

Текущие локальные Docker images:

- `homecloud-restore-e2e-runner:local`;
- `homecloud-restore-e2e-runtime:local`;
- `homecloud-restore-e2e-backend:local`;
- `homecloud-restore-test-runner:local`;
- `postgres:16-alpine`;
- `alpine:latest`.

Runner основан на cached `docker:27-dind` ARM64.

Внутри установлен Linux tooling: Bash, Python, e2fsprogs, util-linux, Docker Compose.

### Изоляция

Outer container запускается:

- `--privileged`;
- `--network none`;
- без host Docker socket;
- без host repository/data mounts;
- с отдельными anonymous Docker volumes для `/var/lib/docker` и `/tmp`;
- с nested dockerd, storage-driver `vfs`;
- с `--iptables=false --ip6tables=false`.

Используются реальные loopback ext4 filesystems внутри disposable runtime.

Важно: privileged nested Docker не является абсолютной security sandbox. Не подключать host devices, secrets или реальные серверные volumes.

### Почему стенд ранее падал

1. Docker Hub pull EOF для `docker:28-dind`.
   Решено использованием cached `docker:27-dind`.

2. Недостаток места в 4 GiB tmpfs для nested vfs.
   Решено disk-backed anonymous volumes.

3. Startup gate не видел UUID symlink из-за mode `0700` на `/dev/disk` и `/dev/disk/by-uuid`.
   Исправлены только права тестовых каталогов до `0755`.

4. Backend `Storage unavailable: identity-mismatch/identity-unverifiable`.
   Причина: отсутствовал внутренний storage marker.
   Решено штатным `bootstrapLegacyMarker('/storage')` под UID/GID `1001:65533`.

5. Upload HTTP 403 `Storage quota exceeded`.
   Причина: новый пользователь имеет нулевую квоту.
   Решено назначением 100 MiB только тестовому пользователю в disposable PostgreSQL.

6. После успешного Backup `RELEASE Compose operation failed`.
   Причина совместимости: отсутствует `start --wait`.

Ни один из этих fixture fixes не требовал отключения production security gate.

### Текущий E2E flow

1. Запуск nested Docker daemon.
2. Загрузка локальных образов.
3. Создание ext4 fixture.
4. Provisioning startup gate configs и volume markers.
5. Provisioning application storage identity.
6. Запуск реального PostgreSQL и production backend.
7. Регистрация тестового пользователя.
8. Выделение квоты.
9. Upload `before-backup.txt` через настоящий API.
10. Fenced Backup.
11. Restart сервисов.
12. Upload `after-backup.txt`.
13. Restore validate-only.
14. Destructive Restore.
15. Проверка API, наличия исходного файла и точного совпадения байтов.
16. Проверка отсутствия файла, созданного после backup.
17. Проверка отсутствия временных restore/maintenance artifacts.
18. Финальный PASS только после всех проверок.

### Известные ограничения стенда

- frontend и ingress пока Alpine-заглушки с простыми healthchecks. Это не полноценная проверка реального frontend/ingress.
- DB и storage ранее размещались на одном loopback ext4 filesystem, хотя production ожидает квалифицированную топологию дисков.
- Не все runtime scripts обязательно упакованы в образ; проверить актуальность.
- Compose file/project-directory и exact deployment labels должны соответствовать recovery contract.
- Последний runtime image не содержит ещё непроверенные исправления restart.
- API verify может потребовать сверки response shape с реальным контроллером.
- Проверить, что runner не тестирует stale backend image после изменений исходников.

Не объявлять такой ограниченный стенд полной production qualification. Для итоговой приёмки явно отделить проверку core Backup/Restore от полноценного deployment E2E.

---

## 14. Последовательность дальнейшей работы

### Этап A. Восстановить зелёные restart регрессии

1. Найти причину трёх ERROR.
2. Исправить её без ослабления identity checks.
3. Прогнать:
   - `scripts/ci/test-recovery-restart.py`;
   - `scripts/ci/test-backup-fence.py`;
   - `scripts/ci/test-restore-maintenance.py`;
   - `scripts/tests/test-restore-health.py`;
   - `scripts/tests/test-restore-preflight.py`;
   - `scripts/tests/test-restore-cleanup.py`.
4. Проверить Python 3.9 и Bash syntax.
5. Исправить аналогичный restart в TEST-канале.
6. Прогнать соответствующие TEST/update regressions.

### Этап B. Полный реальный Backup/Restore

1. Проверить соответствие E2E runner актуальным исходникам.
2. Пересобрать только изменившиеся образы и runtime scripts.
3. Выполнить полный E2E.
4. Самостоятельно диагностировать и исправлять ошибки.
5. Не подменять фактический Restore mock-тестом.
6. Подтвердить восстановление точных байтов, PostgreSQL metadata, quota и journal consistency.
7. Проверить успешный restart и отсутствие residual artifacts.

Если текущий runner недостаточен, исправлять его в основной рабочей директории. Не переносить тесты на реальные данные.

### Этап C. Security hardening

Проверить все пункты раздела 11.

Исправить подтверждённые BLOCKER/HIGH, возникающие в рамках текущей архитектуры и PR.

При обнаружении проблем за пределами текущего scope — зафиксировать отдельно, не начинать произвольный рефакторинг всего HomeCloud.

### Этап D. Crash/fault injection

Проверить реальные или максимально приближенные к production сценарии:

- SIGKILL writer до/после записи физического объекта;
- ambiguous PostgreSQL COMMIT;
- гибель родителя при живом дочернем процессе;
- прерывание backup staging;
- прерывание restore до SQL;
- ошибка SQL внутри транзакции;
- прерывание после DB restore;
- прерывание storage switch;
- прерывание migration;
- прерывание reconciliation;
- прерывание cleanup;
- прерывание READY/restart;
- restart backend при активном inhibitor;
- конкурентный Backup/Restore/Update;
- stale permit и stale receipt.

Для каждого сценария доказать безопасное состояние, корректный отказ или предусмотренный recovery.

### Этап E. Финальные проверки

Выполнить:

- полный backend unit suite;
- backend build и lint;
- реальные PostgreSQL integration tests;
- Linux secure-filesystem/copy/fence tests;
- frontend tests/build/lint;
- thumbnail regressions;
- Backup/Restore regression suites;
- TEST channel/update/installer/host verifier tests;
- production Compose config validation;
- CI workflow validation;
- encrypted backup suite;
- полный реальный E2E;
- `git diff --check`.

Проверить отсутствие регрессий относительно исходной задачи миниатюр, авторизации и файлового менеджера.

Не ограничиваться локальными ARM64 тестами, если production — Linux/AMD64. Квалифицировать обязательные production платформы существующими CI или соответствующим изолированным окружением.

### Этап F. Git и подготовка PR

После успешных проверок:

1. Проверить полный diff.
2. Убедиться в сохранности всей нужной работы.
3. Отделить временные диагностические файлы от постоянных тестов.
4. Не включать посторонние untracked файлы.
5. Обновить документацию и evidence.
6. Подготовить логически завершённые коммиты с русскими сообщениями.
7. Проверить отсутствие stale generated artifacts, secrets и лишних зависимостей.
8. Проверить соответствие PR scope.
9. Подготовить финальный отчёт и список коммитов.

Не выполнять merge, deploy или release. Публикацию коммитов и изменение PR выполнять только после отдельного согласования пользователя.

---

## 15. Файлы, которые нельзя потерять

Особенно внимательно отнестись к новым untracked файлам — они ещё не сохранены в Git history.

### Backend

- `backend/docker/copy-root-fence-supervisor.cjs`
- `backend/src/api-bootstrap.ts`
- `backend/src/files/file-copy-admission.postgres.spec.ts`
- `backend/src/files/file-copy-admission.service.ts`
- `backend/src/files/file-copy-offline-recovery.ts`
- `backend/src/files/file-copy-recovery-cli.ts`
- `backend/src/migrations/1792831300000-FileCopyAdmission.ts`
- `backend/src/uploads/inherited-root-fence.ts`
- `backend/src/uploads/secure-filesystem-root-lock.spec.ts`
- новые runtime CJS tests и worker fixtures в `backend/test/`.

### Linux

- `deploy/linux/maintenance-inhibit.py`
- `deploy/linux/maintenance-window.py`
- `deploy/linux/recover-copy.py`
- `deploy/linux/storage-writer-fence.py`

### Recovery

- `scripts/restore_maintenance.py`
- `scripts/restore_storage.py`

### Тесты

- `scripts/ci/test-backup-fence.py`
- `scripts/ci/test-copy-recovery-e2e.sh`
- `scripts/ci/test-maintenance-inhibit.py`
- `scripts/ci/test-maintenance-supervisor.sh`
- `scripts/ci/test-maintenance-window.py`
- `scripts/ci/test-recover-copy.py`
- `scripts/ci/test-recovery-restart.py`
- `scripts/ci/test-restore-e2e-local.sh`
- `scripts/ci/test-restore-maintenance.py`
- `scripts/ci/test-restore-storage-fence.py`
- `scripts/ci/test-restore-storage-linux.py`
- `scripts/ci/test-storage-writer-fence.py`

Посторонние untracked файлы, которые предыдущая работа намеренно не затрагивала:

- `docs/evidence/frontend-functional/closure-checkpoint.json`
- `docs/evidence/frontend-functional/closure-controls.json`
- `scripts/tests/PHASE-5.3.1-TEST-AUDIT.md`

Не удалять их, не включать автоматически в коммиты текущих security fixes.

---

## 16. Критерии окончательного завершения

Задача не считается завершённой, пока одновременно не выполнены:

- B01/B02 проверены по реальным сценариям.
- Нет открытых подтверждённых BLOCKER/HIGH в scope PR.
- Restart совместим с поддерживаемым Compose.
- RELEASE Backup lifecycle проходит целиком.
- Restore lifecycle проходит целиком.
- TEST lifecycle не содержит обходов maintenance/fencing.
- PostgreSQL и storage остаются согласованными после ошибок и crash recovery.
- Migration permit не позволяет неавторизованный запуск.
- Все обязательные security regression tests подключены к CI.
- Не ухудшена исходная функциональность PR #45.
- Полный итоговый набор тестов выполнен с понятным отчётом.
- Git diff проверен, рабочая ветка организована, нет случайно потерянных файлов.
- Известные ограничения и непроверенные сценарии явно перечислены.
- Подготовлены материалы для независимого security review точного финального HEAD.

**Зелёные unit-тесты сами по себе не являются основанием закрыть security BLOCKER.**

---

## 17. Формат итогового отчёта

В финале предоставить:

1. **Вердикт:** READY FOR INDEPENDENT REVIEW / NOT READY.
2. Точная ветка, HEAD, base PR.
3. Что было реализовано и что дополнительно исправлено.
4. Таблица B01/B02: finding, исправление, файлы, тесты, доказательства.
5. Все команды проверок, количество PASS/FAIL/SKIP.
6. Результат реального Backup → Restore.
7. Результаты fault injection.
8. Список изменённых файлов и логических коммитов.
9. Состояние CI и PR.
10. Неустранённые риски, ограничения стенда и блокеры.
11. Состояние рабочего дерева и незакоммиченные файлы.
12. Подтверждение отсутствия merge/deploy/release.

Работать автономно: самостоятельно читать исходники, запускать проверки, анализировать падения и вносить необходимые изменения. Не останавливать работу после первого успешного теста.

Если дальнейшее исправление требует архитектурного решения, расширения scope, доступа к production, destructive Git-операции или изменения доверенной deployment boundary — остановиться на этом конкретном вопросе, описать риск и запросить согласование.

**Конечная цель: сохранить всю выполненную работу и довести HomeCloud PR #45 до доказуемой безопасности, стабильности и готовности к финальному независимому review.**

## 18. Журнал автономного завершения (12 ноября 2026)

- Начало: ветка `миниатюры-файлов-v1`, HEAD `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`; staged diff пуст; 40 tracked modified и 39 untracked. Предыдущая работа сохранена, 3 посторонних untracked не изменяются.
- Подтверждён ошибочный декоратор `@contextmanager`: перенесён с `release_service_identities` на `release_backup_window`. Restart 9/9 PASS, backup fence/lifecycle 30/30 PASS (Python 3.9).
- TEST restart переведён на plain `start` и bounded inspection всех 4 сервисов с exact container/image/mount identity. Обновляются regression fixtures, добавляются отрицательные тесты.
- Независимый разбор выявил: storage staging после SQL; stale migration permit; прямой api-bootstrap обход fence; READY receipt не блокировал новую операцию. Исправления в работе, findings не закрыты.
- Блокер среды: Docker CLI получает `permission denied` при подключении к unix:///Users/aleksejkozemakin/.docker/run/docker.sock; sandbox запрещает этот доступ и не допускает escalation. Реальные Linux/Docker/PostgreSQL/E2E прогоны пока НЕ выполнены. Production не используется.
- Git metadata read-only в sandbox: запись fixture object overlay под `.git` недоступна; test fixture перемещена в disposable temp object directory, без checkout/клона/worktree и изменения реальных Git refs.
- Никаких push/merge/deploy/release. Статус: IN PROGRESS, B01/B02 открыты до полного подтверждения.


### Журнал: проверка исходников и CI

- Исправлены подтверждённые причины: stage-before-SQL с durable STORAGE_STAGED; content/inode digest; сохранение app marker при switch; marker исключён из backup, пользовательские `.tmp` файлы более не теряются из-за широкого glob.
- Перед cleanup swap выполняются reconciliation, pending journal, writer/fence/marker checks; исходные container/image identities записаны в receipt и проверяются до start и при ack.
- READY receipt и stale permits блокируют новые операции через общий operation admission. Снятие marker при неуспешном restart восстанавливается в штатном retain; crash требует operator reconciliation.
- Restore migration permit привязан к marker dev/ino; Node использует BigInt. Проверка expected marker identity действует и без clear.
- API не запускается импортом api-bootstrap; default datasource проверяет inherited fence. Isolated validation теперь provision private tmpfs → drop groups/gid/uid → native supervisor, без отключения fencing.
- Offline copy recovery перед CLI проверяет точный bind/config и независимый inventory всех writable mounts через recovery_storage.
- CI: contracts, real Linux root crash/filesystem, native inherited/CLI/supervisor runtime, encrypted age backup; production image maintenance/copy recovery; полный BackupRestore nested E2E подключены. CI full E2E использует retained OCI candidate, не повторную сборку.
- Добавлен `bash scripts/ci/run-restore-e2e-local.sh linux/arm64`: пересборка актуальных local sources, source allowlist runtime, network none, без host mounts/socket/data. Локально команда отказывает на Docker info (EPERM), ничего не построено и E2E не выполнялся.
- Backend targeted 5 suites / 202 PASS; frontend 78 reported suites / 434 PASS. Lint/build обоих PASS, backend 20 существующих warnings. Полный backend unit первый прогон FAIL (795 PASS / 318 FAIL / 26 SKIP; в ходе записи нового contract test была transient compile ошибка, затем исправлена и targeted7 PASS). Финальный повтор полного unit прерван unhandled listen EPERM, JSON не создан. Дальнейшие одинаковые прогоны остановлены, security checks не ослаблены.
- Integration route: 14 suites / 109 PASS, 19 suites / 318 SKIP (нет PostgreSQL test URL). Это НЕ PostgreSQL PASS. Linux native/root/runtime тесты не квалифицированы на Mac.
- Synthetic Compose config 4 профиля PASS; YAML обеих workflows parse PASS; Python3.9 AST/Bash syntax/diff-check PASS.
- Encrypted suite отказал: отсутствуют age/age-keygen. Scheduled operations отказал при bind 127.0.0.1 EPERM.
- Отдельная проверка GitHub: PR45 draft/open, HEAD/base прежние; 3 опубликованных workflows success относятся ТОЛЬКО ee84ddd6, а не локальным fixes. Комментариев review в PR connector не вернул.
- Предварительный независимый source review устранённых findings выполнен, найденный /app preload исправлен. Новый E2E runner не построен: совместимость Debian docker.io и pinned Compose, ext4/DB/API lifecycle — обязательный remaining qualification.


## 19. Итоговый отчёт текущего сеанса

**Вердикт: NOT READY.** Ни COMPLETE, ни закрытие B01/B02 не установлены. Это сохранённый рабочий checkpoint для продолжения, не подтверждение production qualification.

### 19.1. Git и PR

- Ветка: `миниатюры-файлов-v1`.
- HEAD: `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`.
- PR #45 → `test`, base `85578280b40d485c2765e961e6ec4f591d43f02c` (сверены GitHub и локальный origin/test).
- PR остаётся draft/open; опубликованный CI success относится к старому HEAD. Локальные изменения не публиковались и CI их не выполнял.
- Новых коммитов нет; staged diff пуст. Предыдущая незакоммиченная работа сохранена. Коммиты не подготовлены как завершённые: обязательные acceptance gates ещё не подтверждены; Git metadata также read-only в этом sandbox.
- 47 tracked modified + 47 untracked (включая этот handoff, JSON evidence и 3 посторонних исходных файла). Посторонние closure-checkpoint.json, closure-controls.json и PHASE-5.3.1-TEST-AUDIT.md не изменялись и не включались никуда автоматически.
- Push, merge, deploy, release и работа с production не выполнялись. Новых веток, worktree и клонов нет.

### 19.2. Проверяемый рабочий snapshot

Список файлов, SHA256 каждого и команды/результаты сохранены в `docs/handoff/PR-45-CLOSURE-CHECKS.json`.

Code snapshot SHA256: `0ca5a5384fab9880d5d1d6ea9aa202295be2887373e4951e80fc628eaed370e1`.

Hash связывает 89 изменённых/new source/config/test файлов. Из него исключены сам handoff, JSON evidence и 3 посторонних untracked. Это контрольная сумма рабочего содержимого, не Git commit и не доказательство runtime.

### 19.3. Findings и исправления

| Finding | Исправление и файлы | Проверка | Статус |
|---|---|---|---|
| B01: durable copy, ambiguous COMMIT и quota | Сохранены admission/journal migration, транзакционная публикация и cleanup claim: backend/src/files/file-copy-*; files.service.ts; uploads/ssd-uploads | Portable targeted205; реальные PG suites подключены к integration route, локально skipped | OPEN: нужны реальные PG/crash доказательства |
| B01: Restore менял DB до extraction | restore_storage.py разделяет stage/switch, receipt STORAGE_STAGED хранит archive/count/inode/tree hash; restore.sh stage и verify до SQL | storage-fence17, maintenance27, schema24, validator3 | Код исправлен; полный E2E не выполнен |
| B01: потеря локальной storage identity и пользовательских .tmp файлов | backup.sh исключает только root .tmp и identity marker; restore сохраняет текущий root marker | реальный portable tar test1; preservation/tamper/disk-full tests | Код исправлен; historical marker archives остаются fail-closed |
| B02: direct bootstrap / CLI aliases / env bypass | api-bootstrap экспортирует fenced bootstrap без side effect; main gated import; default datasource initialize требует fence на ВСЁМ Linux; offline CLI own root lock; disposable fixtures explicit DataSource options | startup contract10, backend lint/build | Linux syscalls должны пройти в CI |
| B02: stale restore permit | basename содержит token и marker dev/ino, lstat BigInt в supervisor/startup-gate, receipt host revocation identity | permit VM9, host maintenance27 | Native migration runtime не выполнен |
| B02: READY и конкурентные операции | operation admission отказывает при receipt/permit; shared lock; retained receipt до restart/ack; expected marker identity проверяется и без удаления | inhibitor15, backup-fence31, maintenance27 | Core recovery fault matrix ещё не квалифицирована |
| B02: offline recovery foreign writer | recover-copy.py вызывает shared exact bind/config и all-container writable mounts verification; root lock CLI сохранён | recover-copy8, backup-fence31 | Cross-container native E2E не выполнен |
| Restart compatibility RELEASE/TEST | исправлен contextmanager; plain Compose start, exact original ID/image и readiness; TEST также mounts, bounded deadline, fatal inspect errors | RELEASE10, TEST7, backup31, TEST channel43 | Portable PASS; реальный restart не подтверждён |

### 19.4. Команды и результаты

Итого distinct portable contract commands: **567 PASS / 0 FAIL / 3 SKIP**, 38 команд. Повторные прогоны одной команды не складываются. Три skip — baseline-only сравнения в test-recovery-storage.py; это отдельный класс от непроверенных PG/native scenarios.

| Команда (из корня проекта) | PASS | FAIL | SKIP |
|---|---:|---:|---:|
| `python3 -B scripts/ci/test-recovery-restart.py` | 10 | 0 | 0 |
| `python3 -B scripts/ci/test-test-channel-restart.py` | 7 | 0 | 0 |
| `python3 -B scripts/ci/test-backup-archive.py` | 1 | 0 | 0 |
| `python3 -B scripts/ci/test-backup-fence.py` | 31 | 0 | 0 |
| `python3 -B scripts/ci/test-maintenance-inhibit.py` | 15 | 0 | 0 |
| `python3 -B scripts/ci/test-maintenance-window.py` | 8 | 0 | 0 |
| `python3 -B scripts/ci/test-storage-writer-fence.py` | 9 | 0 | 0 |
| `python3 -B scripts/ci/test-recover-copy.py` | 8 | 0 | 0 |
| `python3 -B scripts/ci/test-restore-storage-fence.py` | 17 | 0 | 0 |
| `python3 -B scripts/ci/test-restore-maintenance.py` | 27 | 0 | 0 |
| `python3 -B scripts/ci/test-restore-validator.py` | 3 | 0 | 0 |
| `python3 -B scripts/tests/test-restore-schema.py` | 24 | 0 | 0 |
| `python3 -B scripts/tests/test-restore-preflight.py` | 13 | 0 | 0 |
| `python3 -B scripts/tests/test-restore-cleanup.py` | 1 | 0 | 0 |
| `python3 -B scripts/tests/test-restore-health.py` | 11 | 0 | 0 |
| `python3 -B scripts/tests/test-restore-storage.py` | 2 | 0 | 0 |
| `python3 -B scripts/ci/test-update-preflight.py` | 5 | 0 | 0 |
| `python3 -B scripts/ci/test-entrypoint.py` | 7 | 0 | 0 |
| `python3 -B scripts/ci/test-test-channel.py` | 43 | 0 | 0 |
| `python3 -B scripts/ci/test-update-host-verify.py` | 18 | 0 | 0 |
| `python3 -B scripts/ci/test-ci-v2-fast-gate.py` | 3 | 0 | 0 |
| `python3 -B scripts/ci/test-ci-gate.py` | 5 | 0 | 0 |
| `python3 -B scripts/ci/test-policy-coverage.py` | 15 | 0 | 0 |
| `python3 -B scripts/ci/test-test-routing.py` | 5 | 0 | 0 |
| `python3 -B deploy/linux/test_startup_gate.py` | 48 | 0 | 0 |
| `python3 -B deploy/linux/test_preflight.py` | 83 | 0 | 0 |
| `node --test backend/test/restore-migration-admission.runtime.cjs` | 9 | 0 | 0 |
| `python3 -B scripts/tests/test-recovery-config.py` | 12 | 0 | 0 |
| `python3 -B scripts/tests/test-recovery-storage.py` | 22 | 0 | 3 |
| `python3 -B scripts/tests/test-operator-preflight.py` | 13 | 0 | 0 |
| `python3 -B scripts/ci/test-root-boundary.py` | 26 | 0 | 0 |
| `python3 -B scripts/ci/test-backup-qualification.py` | 10 | 0 | 0 |
| `python3 -B scripts/ci/test-update-admission.py` | 6 | 0 | 0 |
| `python3 -B scripts/ci/test-update-evidence.py` | 16 | 0 | 0 |
| `python3 -B scripts/ci/test-update-install-bridge.py` | 16 | 0 | 0 |
| `python3 -B scripts/ci/test-update-host-discover.py` | 4 | 0 | 0 |
| `python3 -B scripts/ci/test-update-status-archive.py` | 10 | 0 | 0 |
| `python3 -B scripts/ci/test-update-install-host.py` | 4 | 0 | 0 |

Дополнительные обязательные проверки:

| Команда/набор | Результат |
|---|---|
| `cd backend && npm test -- --runInBand --runTestsByPath src/startup-fence.contract.spec.ts src/files/files.service.spec.ts src/uploads/uploads.service.spec.ts src/uploads/ssd-uploads.service.spec.ts src/previews/previews.service.spec.ts` | 5 suites, 205 PASS / 0 FAIL / 0 SKIP |
| `cd frontend && npm test -- --reporter=json --outputFile=/tmp/hc-pr45-frontend-tests.json` | 434 PASS / 0 FAIL / 0 SKIP; thumbnail regressions включены |
| Полный unit route `python3 scripts/ci/test-routing.py list unit` → Jest `--runInBand --runTestsByPath` | Финальный прогон ABORTED: unhandled listen EPERM, JSON не создан; PASS не установлен |
| Первый unit route (промежуточный snapshot) | 795 PASS / 318 FAIL / 26 SKIP; Linux/native и listen restrictions, плюс затем исправленная transient compile ошибка startup test; не финальный verdict |
| Полный integration route `python3 scripts/ci/test-routing.py list integration` → Jest | 109 PASS / 0 FAIL / 318 SKIP, 14 suites ran / 19 skipped; НЕ реальный PG PASS |
| `npm run lint`, `npm run build` — backend и frontend | PASS; backend20 существующих warnings, 0 errors |
| `python3 -B scripts/ci/compose-check.py` | 4 конфигурационных профиля PASS, локальный Compose5.1.3; без daemon |
| js-yaml parsing `.github/workflows/ci.yml`, `ci-v2-fast.yml` | PASS; это не execution CI и не actionlint |
| `ast.parse(feature_version=9)` по всем changed/new Python; `bash -n` по всем changed/new shell; `node --check` трёх fixture servers | PASS |
| `bash scripts/tests/test-backup-dump-structure.sh` | 3 checks PASS |
| `git diff --check` | PASS |
| `bash scripts/tests/test-backup-production.sh` | BLOCKED/exit1: нет age/age-keygen |
| `python3 -B scripts/tests/test-scheduled-operations.py` | BLOCKED/exit1: bind127.0.0.1 EPERM, 0 tests executed |
| `python3 -B scripts/ci/test-restore-storage-linux.py` | BLOCKED/exit1: Linux root environment required |
| `bash scripts/ci/test-maintenance-supervisor.sh homecloud-restore-e2e-backend:local linux/arm64` | BLOCKED/exit1: Docker socket denied |
| `bash scripts/ci/test-copy-recovery-e2e.sh homecloud-restore-e2e-backend:local linux/arm64` | BLOCKED/exit1: Docker socket denied |
| `bash scripts/ci/run-restore-e2e-local.sh linux/arm64` | BLOCKED/exit1 на docker info; ничего не построено/восстановлено |

Local runtime: macOS/ARM64, Node20.19.4, Python3.9. Production/CI Linux/AMD64 + Node24.21.0 этим не квалифицированы.

### 19.5. Реальный Backup → Restore и fault injection

**Текущий реальный E2E: NOT RUN, PASS отсутствует.** Предыдущие результаты handoff не переобъявлены результатами этого сеанса. Запуск блокируется sandbox до доступа к daemon.

В portable тестах проверены реальные POSIX flock/inode/filesystem операции и fixture-controlled отказы: archive traversal/duplicates/count/checksum, tamper подготовленного дерева, disk-full при staging, partial stop/begin failure, migration/cleanup/reconciliation/restart errors, stale permits, container replacement, operation locks. Docker/DB части этих host contracts замоканы.

Настоящие native SIGKILL/orphan-child/cross-container tests подключены к CI, но здесь не выполнены. Реальный in-flight COMMIT с потерей сетевого подтверждения, прерывания на каждом checkpoint и complete crash-recovery matrix остаются обязательными. 109 portable/bench integration assertions не заменяют skipped PostgreSQL tests.

### 19.6. CI и независимая проверка

- Оба workflows вызывают recovery contracts, native supervisor/CLI/inherited tests, Linux root filesystem/crash и encrypted age suite.
- Release qualification ci.yml выполняет maintenance-supervisor, copy-recovery и полный core BackupRestore на retained production OCI candidate. Launcher проверяет exact image ID/platform; runtime context содержит только allowlisted исходники.
- E2E outer container: network none, private anonymous docker/tmp volumes, без host socket/repository/user data mounts; privileged остаётся существенным ограничением изоляции.
- CI additions, новый Debian docker.io runner и Engine API/pinned Compose совместимость не исполнены и не квалифицированы. Старый cached runner локального стенда остаётся доступным только в сеансе с Docker-доступом.
- Независимый source review другими исполнителями выявил bootstrap/CLI/validator/preload/candidate-binding проблемы; исправления затем перепроверены по исходникам и targeted contracts. Это предварительный source review рабочего дерева, не финальный security PASS точного нового commit.
- GitHub run IDs 42828127020, 42828126813, 42828126997 success относятся ee84ddd6. Локальные fixes отсутствуют в PR/CI.

### 19.7. Оставшиеся ограничения и точка продолжения

1. Продолжить в сеансе с разрешёнными Docker socket и loopback HTTP, Linux root для host tests, PostgreSQL16 и age. Повторять sandbox-denied команды здесь бесполезно.
2. Запустить `bash scripts/ci/run-restore-e2e-local.sh linux/arm64`, устранить фактические runtime ошибки, подтвердить байты/metadata/quota/journal/IDs и cleanup. Если cached runner отсутствует, новый test tooling Dockerfile ещё требует build/qualification.
3. Выполнить Linux/AMD64 CI через согласованную публикацию либо отдельный изолированный AMD64 стенд. Push в этом сеансе не разрешён и не выполнялся.
4. Пройти полный unit/integration/native/crash/HTTP/encrypted набор и все точки fault injection. Реальный in-flight COMMIT vs cleanup claim отдельно не квалифицирован.
5. Core E2E использует frontend/ingress заглушки и общий ext4 для DB/storage. Полная deployment qualification требует реальных frontend/ingress и квалифицированной disk topology.
6. Исторические архивы с root `.homecloud-storage-identity` сейчас fail-closed; автоматический перенос identity не разрешён. Старый ручной test-d1-historical.py также ожидает current13 и не считается пройденным текущим gate.
7. Existing TEST host обязан отказать изменённому immutable deploy/Compose contract до отдельной manual qualification. Root anchors/host verifier не ослаблялись, обновление действующего хоста не выполнялось.
8. Только после обязательных PASS сформировать маленькие русские коммиты, финальный independent review exact HEAD и запрашивать отдельно разрешение на push/изменение PR. До этого B01/B02 OPEN и NOT READY.

### 19.8. Список source/config/test изменений (кроме handoff/evidence)

Полный список сохранён также в JSON с SHA256. Это общий результат предыдущей работы и данного сеанса; не все перечисленные изменения авторства этого сеанса.

- `.github/workflows/ci-v2-fast.yml` — modified.
- `.github/workflows/ci.yml` — modified.
- `backend/bench/copy-file-runner.spec.ts` — modified.
- `backend/docker/copy-root-fence-supervisor.cjs` — untracked.
- `backend/docker/entrypoint.sh` — modified.
- `backend/src/api-bootstrap.ts` — untracked.
- `backend/src/data-source.ts` — modified.
- `backend/src/files/file-copy-admission.postgres.spec.ts` — untracked.
- `backend/src/files/file-copy-admission.service.ts` — untracked.
- `backend/src/files/file-copy-offline-recovery.ts` — untracked.
- `backend/src/files/file-copy-recovery-cli.ts` — untracked.
- `backend/src/files/files.module.ts` — modified.
- `backend/src/files/files.service.postgres.spec.ts` — modified.
- `backend/src/files/files.service.spec.ts` — modified.
- `backend/src/files/files.service.ts` — modified.
- `backend/src/files/security-ownership.postgres.spec.ts` — modified.
- `backend/src/main.ts` — modified.
- `backend/src/migrations/1792831300000-FileCopyAdmission.ts` — untracked.
- `backend/src/startup-fence.contract.spec.ts` — untracked.
- `backend/src/storage/storage-secure-copy.spec.ts` — modified.
- `backend/src/storage/storage.service.ts` — modified.
- `backend/src/uploads/inherited-root-fence.ts` — untracked.
- `backend/src/uploads/legacy-publication.postgres.spec.ts` — modified.
- `backend/src/uploads/secure-filesystem-root-lock.spec.ts` — untracked.
- `backend/src/uploads/ssd-uploads.service.spec.ts` — modified.
- `backend/src/uploads/ssd-uploads.service.ts` — modified.
- `backend/src/uploads/upload-rate-limit.postgres.spec.ts` — modified.
- `backend/src/uploads/uploads.service.postgres.spec.ts` — modified.
- `backend/src/uploads/uploads.service.spec.ts` — modified.
- `backend/src/uploads/uploads.service.ts` — modified.
- `backend/test/copy-root-fence-supervisor.runtime.cjs` — untracked.
- `backend/test/entrypoint-fence-preload.cjs` — untracked.
- `backend/test/file-copy-crash-worker.cjs` — untracked.
- `backend/test/frontend-ssd-browser/server.cjs` — modified.
- `backend/test/inherited-root-fence.runtime.cjs` — untracked.
- `backend/test/operator-cli-fence.runtime.cjs` — untracked.
- `backend/test/restore-migration-admission.runtime.cjs` — untracked.
- `backend/test/secure-root-lock-inherit-worker.cjs` — untracked.
- `backend/test/secure-root-lock-worker.cjs` — untracked.
- `backend/test/ssd-upload-api.cjs` — modified.
- `deploy/linux/maintenance-inhibit.py` — untracked.
- `deploy/linux/maintenance-window.py` — untracked.
- `deploy/linux/preflight.py` — modified.
- `deploy/linux/project-test.sh` — modified.
- `deploy/linux/recover-copy.py` — untracked.
- `deploy/linux/startup-gate.sh` — modified.
- `deploy/linux/storage-writer-fence.py` — untracked.
- `deploy/linux/test-channel.py` — modified.
- `deploy/linux/test_preflight.py` — modified.
- `deploy/linux/test_startup_gate.py` — modified.
- `docker-compose.production.yml` — modified.
- `docker-compose.project-test-updates.yml` — modified.
- `docker-compose.project-test.yml` — modified.
- `scripts/backup-production.py` — modified.
- `scripts/backup.sh` — modified.
- `scripts/ci/restore-e2e-runner.Dockerfile` — untracked.
- `scripts/ci/run-restore-e2e-local.sh` — untracked.
- `scripts/ci/test-backup-archive.py` — untracked.
- `scripts/ci/test-backup-fence.py` — untracked.
- `scripts/ci/test-copy-recovery-e2e.sh` — untracked.
- `scripts/ci/test-entrypoint.py` — modified.
- `scripts/ci/test-maintenance-inhibit.py` — untracked.
- `scripts/ci/test-maintenance-supervisor.sh` — untracked.
- `scripts/ci/test-maintenance-window.py` — untracked.
- `scripts/ci/test-recover-copy.py` — untracked.
- `scripts/ci/test-recovery-contracts.sh` — untracked.
- `scripts/ci/test-recovery-restart.py` — untracked.
- `scripts/ci/test-restore-e2e-local.sh` — untracked.
- `scripts/ci/test-restore-maintenance.py` — untracked.
- `scripts/ci/test-restore-storage-fence.py` — untracked.
- `scripts/ci/test-restore-storage-linux.py` — untracked.
- `scripts/ci/test-restore-validator.py` — untracked.
- `scripts/ci/test-storage-writer-fence.py` — untracked.
- `scripts/ci/test-test-channel-restart.py` — untracked.
- `scripts/ci/test-test-channel.py` — modified.
- `scripts/ci/test-update-preflight.py` — modified.
- `scripts/reconcile.py` — modified.
- `scripts/recovery-pending.sql` — modified.
- `scripts/recovery_storage.py` — modified.
- `scripts/restore.sh` — modified.
- `scripts/restore_maintenance.py` — untracked.
- `scripts/restore_storage.py` — untracked.
- `scripts/tests/public-folder-fixture-server.cjs` — modified.
- `scripts/tests/test-backup-production.sh` — modified.
- `scripts/tests/test-restore-health.py` — modified.
- `scripts/tests/test-restore-preflight.py` — modified.
- `scripts/tests/test-restore-schema.py` — modified.
- `scripts/tests/test-restore-storage.py` — modified.
- `scripts/tests/test-scheduled-operations.py` — modified.


## 20. Продолжение с проверенного checkpoint — 13 ноября 2026

### 20.1. Исходное состояние и сохранность

Перед изменениями проверены ветка `миниатюры-файлов-v1`, HEAD `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`, staged diff и все modified/untracked paths. Все **89/89 файлов исходного manifest совпали по SHA256**, несовпадений 0. Предыдущая работа не откатывалась. Baseline manifest и результаты сохранены в JSON `checkpoint_history`.

Актуальный code snapshot: `ac4c9adf496fc7eeb185765b29eca45fa5bc083ceed46706e09b48f7e840e639`, **92 файла**. В JSON есть SHA256 каждого, перечень changed_since_checkpoint и новых файлов. Backend/frontend исходники совпадают с предыдущим checkpoint; новых TypeScript/CJS правок в этом продолжении нет.

### 20.2. Исторические backup с root identity marker

Реализован совместимый контракт в `restore_storage.py`, `restore.sh` и `restore_maintenance.py`:

- Единственный root regular-file `.homecloud-storage-identity` допускается как архивная служебная запись только при точных canonical bytes штатного `markerContents(legacyBinding)` version1.
- Чтение ограничено 1025 байтами; size должен совпасть с canonical payload. Symlink/hardlink/sparse, directory/children, неверный JSON/ID/version, дубликаты нормализованных путей запрещены.
- Marker учитывается в **исходном archive_file_count**, но не создаётся в staging и не заменяет target marker. `file_count` хранит только payload. Исходные backup/checksum/metadata не переписываются.
- Existing target marker обязателен для такого исторического архива; его ownership/mode/nlink/content и dev/ino/ctime/mtime fingerprint закрепляются до SQL, проверяются до и после switch. Автоматического enrollment из backup нет.
- Preflight security scan, sparse migration replay и fenced extraction используют один `checked_archive_members` parser. Вложенный пользовательский файл с таким basename остаётся payload.
- Новый backup продолжает исключать root marker; новый format/version не требуется.

В E2E добавлен второй реальный `validate-only → destructive restore` для исторической **формы storage archive**. Fixture создаётся отдельно из disposable backup, исходные backup-файлы проверяются на неизменность. Повторяются API bytes/metadata/quota/journal, target marker inode, container IDs и cleanup проверки. Это не квалификация всех старых DB schemas7–15; данный E2E использует current schema17. **Оба runtime E2E ещё не исполнены из-за Docker denial.**

Независимый source review подтвердил этот контракт; portable archive7 + storage-fence21 + maintenance27 + validator3 + preflight13 =71 PASS при самостоятельном прогоне reviewer. В журнале тестов ниже эти assertions не суммируются второй раз.

### 20.3. Дополнительный подтверждённый finding 11.7: operation lock capture

Независимо воспроизведён acceptance BLOCKER: raw `backup-fence-acquire/check` принимал существующий inhibitor и storage flock без доказательства владения общим install/release operation lock. В portable fixture отдельный владелец удерживал install.lock и существовал restore.pending.json, но старый capture helper разрешал работу. Порча данных этим не доказана; последующие stage/swap gates могли остановить publication.

Исправлено:

- RELEASE `release_backup_window()` возвращает operation FD + identity созданного им marker; `backup-production.py` передаёт FD в raw backup через `pass_fds`.
- TEST `backup(active, install_fd, marker_identity)` передаёт фактический install FD; capture сверяет root-owned durable BACKUP checkpoint ещё до появления backup_id. Completion по-прежнему требует конкретный backup_id.
- Bash дублирует operation FD в8 **до** открытия storage FD9, включая collision исходного FD9.
- Capture CLI до/после root-fence action и перед publication проверяет exact lock inode/owner/mode, настоящий shared locked OFD, marker identity и отсутствие restore receipt/permit.
- Busy lock другого процесса недостаточен: отдельный contender обязан блокироваться, а `flock(inheritedFD)` обязан проходить. Неправильный/unlocked/foreign FD отвергается.
- Cipher/scheduled stubs и backup-qualification fixture адаптированы к новому capture dict; immutable root anchors и host verifier не ослаблялись.

Новый `test-backup-capture.py`:11 PASS, включая actual CLI refusal before root fence, post-action recheck, реальное subprocess inheritance/OFD и FD9 collision. Independent read-only review исходников/fixture callsites новых security HIGH не выявил; это source/portable evidence, не окончательный runtime security PASS.

### 20.4. Проверки текущего продолжения

**21 команда:307 PASS / 0 FAIL / 1 SKIP** — affected recovery/CI contracts и scheduled HTTP. Это отдельный ledger от полного backend unit, который ниже имеет FAIL. Старые 567/3 из раздела19 не считаются заново.

| Команда | PASS | FAIL | SKIP |
|---|---:|---:|---:|
| `python3 -B scripts/ci/test-historical-storage-archive.py` | 7 | 0 | 0 |
| `python3 -B scripts/ci/test-restore-storage-fence.py` | 21 | 0 | 0 |
| `python3 -B scripts/ci/test-restore-maintenance.py` | 27 | 0 | 0 |
| `python3 -B scripts/ci/test-restore-validator.py` | 3 | 0 | 0 |
| `python3 -B scripts/ci/test-backup-capture.py` | 11 | 0 | 0 |
| `python3 -B scripts/ci/test-backup-fence.py` | 31 | 0 | 0 |
| `python3 -B scripts/ci/test-recovery-restart.py` | 10 | 0 | 0 |
| `python3 -B scripts/ci/test-test-channel.py` | 43 | 0 | 0 |
| `python3 -B scripts/ci/test-backup-qualification.py` | 10 | 0 | 0 |
| `python3 -B scripts/ci/test-update-preflight.py` | 5 | 0 | 0 |
| `python3 -B scripts/ci/test-update-host-verify.py` | 18 | 0 | 0 |
| `python3 -B scripts/ci/test-root-boundary.py` | 26 | 0 | 0 |
| `python3 -B scripts/tests/test-restore-preflight.py` | 13 | 0 | 0 |
| `python3 -B scripts/tests/test-restore-health.py` | 11 | 0 | 0 |
| `python3 -B scripts/tests/test-restore-storage.py` | 2 | 0 | 0 |
| `python3 -B scripts/tests/test-restore-schema.py` | 24 | 0 | 0 |
| `python3 -B scripts/tests/test-restore-cleanup.py` | 1 | 0 | 0 |
| `python3 -B scripts/ci/test-ci-gate.py` | 5 | 0 | 0 |
| `python3 -B scripts/ci/test-ci-v2-fast-gate.py` | 3 | 0 | 0 |
| `python3 -B scripts/ci/test-policy-coverage.py` | 15 | 0 | 0 |
| `python3 -B scripts/tests/test-scheduled-operations.py` | 21 | 0 | 1 |

После обновления окружения `socket.bind(('127.0.0.1',0)); listen()` прошёл. Поэтому без изменения security checks заново выполнены ранее заблокированные HTTP проверки:

- Полный backend unit route:80 suites (70 PASS /6 FAIL /4 SKIP); **1080 PASS /43 FAIL /26 SKIP**. JSON завершённого прогона получен.
- Failed suites: upload-rate-limit (13), upload-workspace (11), storage-mount-registry (2), ssd-upload-binding (3), ingress-file-cleanup.interceptor (4), secure-filesystem (10). Workspace/native calls требуют Linux; upload HTTP получает500 при отказе native workspace. Нельзя объявить весь backend PASS по выполненным HTTP assertions.
- После отчёта Jest оставил handles при падающих native suites; собственная exec session остановлена Ctrl-C. `forceExit`, platform spoofing, замена native syscall mock-ами и новые skip flags не добавлялись.
- Scheduled operations:22 tests, **21 PASS /1 SKIP**. Единственный skip — real-age encrypted fixture, отсутствуют age/age-keygen. Реальные HTTP alert failure/recovery маршруты прошли.
- Ранее подтверждённые frontend434, backend targeted205, lint/build сохранены как evidence прошлого checkpoint: backend/frontend source идентичен. Повторный frontend build не требовался. Это не замена новым обязательным Linux/PG gates.
- Python3.9 AST, Bash syntax по changed/new scripts и `git diff --check` — PASS.

### 20.5. Доступ к Docker, PostgreSQL и encrypted qualification

- `docker info --format ...` и `bash scripts/ci/run-restore-e2e-local.sh linux/arm64` отказывают: **permission denied** для `unix:///Users/aleksejkozemakin/.docker/run/docker.sock`. Containers/build не запускались; устаревшие backend образы не использовались.
- Выполнен штатный read-only escalation request для docker info. Запрос отвергнут granular policy: **sandbox_approval=false / request_permissions=false**, пользовательский prompt недоступен. После обновления окружения повторная проверка дала тот же отказ; обходы через другой Docker endpoint/remote host не применялись.
- Найден PostgreSQL **16.15 Homebrew**. Создан отдельный временный initdb fixture с SCRAM, сгенерированным только для него password file0600; существующие БД и конфигурация не использовались.
- `initdb` остановился на **shmget: Operation not permitted** при bootstrap. PostgreSQL server не запускался; PG tests executed=0. Собственный failed fixture и его password file удалены. **Все 318 ранее пропущенных PostgreSQL tests остаются НЕ квалифицированы.**
- Linux root suite отказывает на macOS штатно. Copy recovery, maintenance supervisor, inherited/orphan fence, native SIGKILL и вся crash/fault matrix требуют Linux/Docker.
- `bash scripts/tests/test-backup-production.sh` останавливается до тестов: age/age-keygen required. Это не encrypted PASS.

### 20.6. CI, Git и решение

Повторно прочитаны CI wiring и launcher candidate binding: Linux/AMD64 E2E получает retained `homecloud-ci-backend:${github.sha}`, проверяет image ID/platform, без повторной backend сборки для CI. Native/copy/maintenance проверки связаны с qualification jobs. Сами новые CI workflows не выполнялись без согласованного push; runner Engine API/Compose совместимость ещё непроверена.

GitHub read-only recheck: PR45 **open/draft**, base `85578280b40d485c2765e961e6ec4f591d43f02c`, remote HEAD `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`; три старых workflow success относятся только ему. Локальные изменения отсутствуют в опубликованном CI. Host verifier/root boundary не изменены и не ослаблены; operational contract по-прежнему требует manual qualification существующего TEST host.

**Вердикт: NOT READY; B01/B02 остаются открыты до runtime qualification.** Новых коммитов нет: обязательные checks не завершены, Git metadata также защищены read-only sandbox. Ветка/HEAD прежние; staged пуст;48 modified +49 untracked. Три посторонних первоначальных файла сохранены. Push/merge/deploy/release, production data, новые ветки/worktree/клоны не использовались.

### 20.7. Минимальная команда вне sandbox на MacBook

Команда жёстко выбирает локальный Docker Desktop socket и снимает optional backend-image override, чтобы backend пересобрался из текущих исходников. Использует существующий runner, disposable ext4/nested daemon, без host data/socket/source mounts внутрь контейнера:

```bash
(
  set -euo pipefail
  cd ~/Desktop/HomeCloud
  test "$(git branch --show-current)" = "миниатюры-файлов-v1"
  env -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    -u HOMECLOUD_E2E_BACKEND_IMAGE \
    DOCKER_HOST="unix://$HOME/.docker/run/docker.sock" \
    bash scripts/ci/run-restore-e2e-local.sh linux/arm64 2>&1 \
    | tee /tmp/homecloud-pr45-e2e.log
)
```

Ожидаются оба маркера: `PASS: HISTORICAL ROOT IDENTITY BACKUP -> RESTORE` и `PASS: REAL BACKUP -> RESTORE E2E`. До наблюдения этих результатов runtime PASS не установлен. При ошибке продолжить диагностику по `/tmp/homecloud-pr45-e2e.log`, не повторяя весь source implementation с нуля. Далее обязательны полный backend/native/PG16, age/encrypted, Linux/AMD64 и все fault-injection gates; только после них коммиты и final independent review exact HEAD.


## 21. Продолжение по реальному E2E: runtime packaging и trust preflight

### 21.1. Фактическое состояние и входной лог

Ветка `миниатюры-файлов-v1`, HEAD `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`, PR45 прежние. На старте manifest92 совпал **92/92**, вся незакоммиченная работа сохранена. В этом продолжении изменены только три существующих fixture-файла и добавлены три packaging/preflight/test файла; production source и deployment trust boundary совпадают с checkpoint20.

Прочитан `/tmp/homecloud-pr45-e2e.log`:372 строки,36497 bytes, SHA256 `0c6883a111a95f6ab37fe419da84efeec747b7e4cc744c3e61f122baa14ee71f`. Это выполнение пользователя в обычном Terminal, не выполнение Docker агентом. Лог подтверждает актуальную сборку backend, healthy PostgreSQL16.15/backend, production startup disk gate, enrollment identity, real API register/login/upload `before-backup.txt`. Outer Engine29.4.1 указан пользователем; nested daemon в логе27.5.1.

Backend manifest `sha256:c10907214fd2a96830f5fa86b310783708dd80755c70cc581fd163009752dbfc`; config `sha256:e170d1d252b38b907f361e0905d6e23df20f955d7c63845d94977446ad0eb78d`; manifest list/printed image `sha256:eeaa4c83c186cc8f76dabb1c06e10ea8a0df3cc61b7f29806bfa16c275cfec8f`.

`FENCED BACKUP` останавливается на `Untrusted RELEASE maintenance helper` до backup и writer shutdown; четыре сервиса healthy. **Backup→Restore PASS отсутствует.** В старом логе нет stat helper внутри image: точное нарушенное поле старого runtime не установлено.

### 21.2. Trust contract и исправление fixture

Проверен фактический `create_release_inhibit()` в `scripts/recovery_storage.py`: путь строго `/opt/homecloud/deploy/linux/maintenance-inhibit.py`, `lstat` требует regular file, UID0, отсутствие group/world write и canonical resolve. Symlink отвергается regular/canonical проверками. `qualified_state_path(parent)` требует canonical absolute path и root-owned directory без022 на каждом уровне до `/`. Production contract **не содержит отдельного требования GID0/nlink1**; это не объявляется существующей production защитой.

Mac source helper фактически `501:20`, mode0644, regular, canonical, nlink1. Прежний `tar.add` сохранял source metadata, а `COPY .` не задавал owner явно. Это подтверждённое отсутствие нормализации fixture, но без stat старого образа нельзя объявлять UID единственной доказанной причиной его отказа.

Исправление ограничено packaging:

- Новый `scripts/ci/restore-e2e-context.py` создаёт allowlisted tar с numeric UID/GID0:0, directory0755, file0644/0755, без Mac ACL/xattrs, privileged/write bits; отказывает source symlink/noncanonical parent и hardlink. Source contents сохраняются; host chown/chmod не выполняется.
- Dockerfile явно задаёт `USER 0:0`, `COPY --chown=0:0`, directory0755 для `/opt`, `/opt/homecloud` и дерева fixture.
- Новый `restore-runtime-preflight.py` проверяет15 helper/script файлов: canonical path, regular file, UID/GID0, отсутствие022, nlink1; все parent dirs canonical/root-owned/nonwritable. Более строгие GID/nlink требования относятся **только к disposable fixture**. Затем вызывается actual production `qualified_state_path()` без создания inhibitor/lock/daemon.
- Preflight встроен в Dockerfile RUN; дополнительно выполняется внутри actual image отдельным container с `--network none --cap-drop ALL --security-opt no-new-privileges`, без mounts, до docker save/nested daemon. Entrypoint повторяет проверку до запуска daemon. При отказе печатаются диагностические path/uid/gid/mode/nlink/canonical поля.
- Production guards, `update-host-verify.py`, `root-boundary.py`, Compose, CI workflows, retained OCI candidate binding и security checks не ослаблены и не изменены этим исправлением. Изменён только recovery contracts test list для запуска нового portable regression.

Actual source tar проверен без Docker:51 members, helper0:0/0644, все directories0755, только regular files/directories, writable metadata отсутствует. SHA256 tar `40c3ac2d37c07bdfc33ae8f101096a8ff4a8151709fc3e99982fc54f466a2b48`.

### 21.3. Проверки и независимый review

**10 команд,134 PASS /0 FAIL /0 SKIP.** Это новое ограниченное выполнение, не сумма с307/1 из раздела20 и не полный backend/native/PG PASS.

| Команда | PASS |
|---|---:|
| `python3 -B scripts/ci/test-restore-runtime-context.py` | 8 |
| `python3 -B scripts/ci/test-backup-fence.py` | 31 |
| `python3 -B scripts/ci/test-backup-capture.py` | 11 |
| `python3 -B scripts/ci/test-recovery-restart.py` | 10 |
| `python3 -B scripts/ci/test-restore-maintenance.py` | 27 |
| `python3 -B scripts/ci/test-restore-validator.py` | 3 |
| `python3 -B scripts/tests/test-restore-preflight.py` | 13 |
| `python3 -B scripts/tests/test-restore-health.py` | 11 |
| `python3 -B scripts/ci/test-ci-gate.py` | 5 |
| `python3 -B scripts/ci/test-policy-coverage.py` | 15 |

Новые8 проверяют tar normalization, сохранность содержимого/host mode, allowlist, refusal symlink/hardlink/writable parent/owner/group/type/canonical mismatch и порядок preflight до daemon. Portable layout tests подставляют Linux UID/GID и system ancestor metadata, оставляя actual filesystem type/mode/nlink/path внутри fixture; **это не запуск нового image**.

Bash syntax трёх изменённых shell scripts, Python3.9 AST трёх новых файлов, actual repo tar metadata, import production recovery_storage с runtime sys.path и `git diff --check` — PASS. Первый ad-hoc import без scripts в sys.path отказал на recovery_config; повтор с тем же sys.path, который задаёт preflight, прошёл. Fixture preflight уже содержит правильный sys.path.

Независимый read-only source review: новых подтверждённых BLOCKER/HIGH не обнаружено; самостоятельно8/8 PASS, syntax/whitespace PASS; подтверждены51 tar member и отсутствие production guard/host verifier изменений. Review прямо оставляет actual image и Backup→Restore pending.

### 21.4. Блокер среды и следующий запуск

Повторный read-only `docker info` в текущей сессии: **permission denied while trying to connect to the docker API at unix:///Users/aleksejkozemakin/.docker/run/docker.sock**. Поэтому build/preflight нового runtime и последующий Backup→Restore агентом не выполнялись. Старое автоматическое отклонение escalation policy сохранено в разделе20; повторных запросов/обходов не было.

Минимальный повтор в обычном Terminal на MacBook; старый диагностический log сохраняется, новый пишется отдельно:

```bash
(
  set -euo pipefail
  cd ~/Desktop/HomeCloud
  test "$(git branch --show-current)" = "миниатюры-файлов-v1"
  env -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    -u HOMECLOUD_E2E_BACKEND_IMAGE \
    DOCKER_HOST="unix://$HOME/.docker/run/docker.sock" \
    bash scripts/ci/run-restore-e2e-local.sh linux/arm64 2>&1 \
    | tee /tmp/homecloud-pr45-e2e-rerun.log
)
```

До `=== PRIVATE DOCKER DAEMON ===` должен появиться `PASS: runtime trusted helpers and production ancestry contract` с metadata records. Затем обязательны `PASS: HISTORICAL ROOT IDENTITY BACKUP -> RESTORE` и `PASS: REAL BACKUP -> RESTORE E2E`. Следующий runtime отказ разбирать по новому полному логу с сохранением текущей работы. Полный backend + все318 real PG tests, Linux native/copy recovery/maintenance/inherited-orphan fence/crash и ambiguous COMMIT, age/encrypted, AMD64/CI exact candidate и обязательные пункты11/14/16 остаются открыты до фактических прогонов. Предыдущие source findings B01/B02 не закрываются этим packaging PASS.

### 21.5. Итог checkpoint

**NOT READY.** Исправление fixture подготовлено и проверено portable regressions; реальная квалификация требует нового E2E. Backend/frontend не менялись, их прежние результаты и ограничения сохранены в JSON history. Новых коммитов нет; staged пуст;48 modified +52 untracked. Первоначальные три посторонних файла сохранены. Push/merge/deploy/release, production и новые ветки/worktree/клоны не использовались.

Manifest теперь **95 source files**; SHA256 `90f5ced928d1323f00a5edd811b7046bc77706a9bcd061bd4e5a4503b00c112c`. Предыдущий manifest92 и ledger307/1 сохранены в `checkpoint_history`. JSON содержит SHA входного E2E log, actual image digests, результаты10 команд, scope/limitations review, текущий snapshot и команду продолжения. Не повторять реализацию или уже подтверждённые переносимые этапы без новой причины.


## 22. Продолжение после rerun: Backup PASS, nested cgroup v2 qualification pending

### 22.1. Входной checkpoint и фактический runtime результат

Manifest95 совпал95/95. Ветка `миниатюры-файлов-v1`, HEAD `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`, PR45/base прежние; staged пуст. Прежняя работа сохранена.

Прочитан `/tmp/homecloud-pr45-e2e-rerun.log`:478 строк,46679 bytes, SHA256 `4cb343952b1c9625b314d8793c246e79e0024c4d85da0982c5cbf425e5fc9f88`. Выполнение пользователя в обычном Terminal относится к manifest95. Backend fresh-source Docker build использовал cached слои с прежними content manifest/config digest; это не запуск произвольно старого образа. Новый manifest list `sha256:5efae146379d19708c8d0bf2540775fa52993ec8f78e113bb06b3be5d8a08111`; content manifest `sha256:c10907214fd2a96830f5fa86b310783708dd80755c70cc581fd163009752dbfc`, config `sha256:e170d1d252b38b907f361e0905d6e23df20f955d7c63845d94977446ad0eb78d`.

**Реально подтверждено в логе:**

- Runtime image manifest list `sha256:733042c99fd28b56986f9fe2495dd37b9ae6b70fc228f28a0b79260c92481f92` успешно собран. Все три actual-image trust gates PASS. Helper внутри image: UID/GID0:0,0644,nlink1,regular,canonical. Предыдущий отказ `Untrusted RELEASE maintenance helper` больше не воспроизводится.
- PG16.15/backend healthy, production startup disk gates, storage identity enrollment, real API registration/login и `before-backup.txt` upload PASS.
- `Exclusive backup storage fence: acquired`, real DB dump + storage archive, checksums/metadata sidecar и atomic publication PASS. Backup ID `20261113_095758_ca056ccd`; event `backup_completed`, exit_code0. DB SHA256 `109c9d9382487d5f343fb53e12d0cc0381be045943c43ddcedfb3eaee3fb8b17`, storage SHA256 `0c949f67b45f6cba47f2aaef2dd48108d7565065ba6548da1125d5bb38cd513b`.
- `PASS: actual Backup and fenced restart`; после restart real API upload `after-backup.txt` PASS.
- Validate-only restore: artifacts/permissions/checksums/gzip/tar/security scan/file count/storage identity/mount/backend image checks PASS.

**Новый отказ** — первый resource-constrained validation DB container: `cannot enter cgroupv2 "/sys/fs/cgroup/docker" with domain controllers -- it is in threaded mode`; `ERROR: Could not start isolated validation DB`. Все четыре services healthy. До destructive restore дело не дошло; **полного Backup→Restore, historical restore, migration replay и crash qualification PASS нет**.

### 22.2. Исправление disposable cgroup setup

Исходник fixture запускал dockerd напрямую, без подготовки namespaced cgroup v2 root. В отличие от обычных unrestricted fixture containers, production validation DB задаёт `--memory 512m --cpus 1 --pids-limit 128`; именно на применении этих domain controllers runc отказал. Production resource/security flags сохранены полностью.

Сверены первичные источники: [upstream Moby DinD setup](https://github.com/moby/moby/blob/master/hack/dind) и [Linux cgroup v2 topology/no-internal-process constraint](https://kernel.org/doc/html/next/admin-guide/cgroup-v2.html). Применён тот же подход топологии: runner processes помещаются в отдельный leaf, controllers включаются на пустом namespace root. Без actual cgroup stat из failed image не утверждается, что обследована вся его kernel topology; новая подготовка ещё требует реального исполнения.

Изменения только fixture:

- Launcher явно задаёт outer `--cgroupns=private`; не добавляет host cgroup/socket/data bind mounts.
- Новый `scripts/ci/restore-e2e-cgroup.py` перед dockerd требует Linux/root/Docker container, fresh unified namespace membership `0::/` у PID1/self, writable cgroup2 mount. Отказывает без cpu/memory/pids, при invalid/threaded root topology или существующем fixture leaf.
- Перемещает runner PIDs в `homecloud-e2e-init`, включая PID1 и shell. Включает все доступные controllers только после evacuation; проверяет пустой root, `domain` и фактическое делегирование. Только ESRCH vanished-process допускается; EBUSY ограничен8 попытками, прочие write/permission errors немедленно останавливают E2E. `cgroup.type` не изменяется на threaded, limits не отключаются.
- Nested dockerd использует явный cgroupfs driver. После image load и **до ext4/data initialization** выполняется реальный probe container с512MiB/1CPU/128PIDs, network none, read-only, no-new-privileges; проверяются kernel `memory.max=536870912`, `pids.max=128`, finite cpu quota=period и domain topology. Отказ не пропускается.
- Cgroup setup включён в root-owned allowlisted tar и trusted runtime preflight; новые regression tests подключены к recovery contracts driver.

Production `restore.sh`, recovery_storage, maintenance/fencing и immutable host verifier/root anchors совпадают с предыдущим manifest. Подготовка предназначена только для disposable container; агент не выполнял её на Mac/host и не менял host cgroups.

### 22.3. Проверки текущего продолжения

`bash scripts/ci/test-recovery-contracts.sh` — exit0:21 Python suites, **250 PASS /1 SKIP**; Node migration admission **9/9 PASS**. Дополнительно CI gate5 и policy coverage15 PASS. Итого **24 команды:279 PASS /0 FAIL /1 SKIP**; предыдущие ledger134 и307 не прибавляются. Единственный skip — encrypted scheduled fixture без `age/age-keygen`.

Новые cgroup12 проверяют evacuation/order, late-PID EBUSY retry, ESRCH, EPERM/EROFS, missing controllers, invalid topology, existing leaf, bounded busy, отсутствие эффекта от успешного write, host/nonprivate refusal и runtime wiring/limits. Первоначальный portable test adapter имел ошибку bound-method patch; adapter исправлен, финальные12/12 PASS. Layout/context8 также PASS.

Эти12 моделируют kernel control-file side effects; **они не считаются Linux cgroup/resource enforcement PASS**. Последний PASS возможен только по новому actual container probe. Bash syntax, Python3.9 AST четырёх changed/new modules, git whitespace PASS. Real repo tar52 members, root0:0/nonwritable, cgroup helper включён; SHA256 `0eeca117b2c0d44562de9773db05ba63aec8cb8e38716568c4e29ba85c09e5ec`.

Полный regression log `/tmp/homecloud-pr45-cgroup-contracts.log`, SHA256 `1a3ddb7f992d73d7ac46f554696122589661226e1d6cd31c163180b803129f5b`. Все24 commands/counts сохранены в JSON. Backend/frontend/full PG suite не повторялись: их source не менялся, Linux/PG qualification остаётся обязательной. Нового независимого agent review этого cgroup изменения не было; предыдущий review касался packaging95.

### 22.4. Точный блокер и команда следующего E2E

Текущий `docker info` снова возвращает **permission denied while trying to connect to the docker API at unix:///Users/aleksejkozemakin/.docker/run/docker.sock**. Новый cgroup setup/actual image probe/полный Restore этой сессией не запускались; обходов sandbox и повторных недоступных escalation не было.

В обычном Terminal MacBook:

```bash
(
  set -euo pipefail
  cd ~/Desktop/HomeCloud
  test "$(git branch --show-current)" = "миниатюры-файлов-v1"
  env -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    -u HOMECLOUD_E2E_BACKEND_IMAGE \
    DOCKER_HOST="unix://$HOME/.docker/run/docker.sock" \
    bash scripts/ci/run-restore-e2e-local.sh linux/arm64 2>&1 \
    | tee /tmp/homecloud-pr45-e2e-cgroup.log
)
```

Новые early markers: `PASS: private cgroup v2 controllers delegated for nested Docker`, `PASS: nested memory/CPU/PID limits applied by kernel`. Далее обязательны полный Restore и historical roundtrip PASS. Предыдущие E2E logs сохраняются; при следующем отказе продолжать с нового log, не начинать исходные исправления заново. Даже после полного E2E остаются Linux/AMD64, full backend,318 real PostgreSQL tests, native/copy recovery/maintenance/inherited-orphan/crash/ambiguous-COMMIT, age/encrypted и exact candidate CI/independent review gates разделов11/14/16.

### 22.5. Состояние

**NOT READY.** B01/B02 остаются открыты до полной runtime/crash qualification; отдельный реальный Backup/restart PASS теперь подтверждён. Manifest **97 source files**, SHA256 `fa4532ea1d0041aa1b61821c5f8669098b1ad6a9a79cc2124284245ec55f6f2a`; baseline95 и его результаты сохранены в JSON checkpoint_history.

Новых коммитов нет, staged пуст,48 modified +54 untracked; три первоначальных посторонних файла сохранены. Production/новые ветки/worktree/клоны/destructive Git/push/merge/deploy/release не использовались. Все исходные изменения сохранены; конечная квалификация и коммиты остаются pending.


## 23. Продолжение после cgroup E2E: Restore admission до SQL

### 23.1. Новый реальный результат

Ветка `миниатюры-файлов-v1`, HEAD `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`, PR45/base прежние. Входной manifest97 совпал97/97; прежняя работа сохранена.

Прочитан `/tmp/homecloud-pr45-e2e-cgroup.log`:539 строк,53996 bytes, SHA256 `c5dfc5e5b4f7be3277c40e771828d669b9dd85f8d10fc946900b7ceecb6acc0a`. Это запуск пользователя в обычном Terminal на исходниках checkpoint22, не Docker execution агента.

Backend printed manifest list `sha256:0d9f98fbb4c5964fabf24c4eecb50f4023b16e8349e369be942d81c85e37a124`, прежний content config `sha256:e170d1d252b38b907f361e0905d6e23df20f955d7c63845d94977446ad0eb78d`; runtime list `sha256:59052c7a0b892562edcbf560d8690694f6b37a1161eab780405f4ce68ed0ebf7`.

Подтверждено реально:

- Все trust preflights PASS.
- Private cgroup root: `domain`, root_processes0; controllers cpu/cpuset/hugetlb/io/memory/pids/rdma делегированы. **Kernel memory/CPU/PID limits probe PASS.** Cgroup blocker раздела22 больше не воспроизводится.
- Startup disk gate/enrollment identity, PG/backend healthy, real API uploads до/после backup PASS.
- Backup ID `20261113_102313_dfb70044`, backup_completed exit0; DB SHA256 `6915bf6e15b509a35fe0cb782452d024809ea64010b5d7a4c56e65679001e3a1`, storage SHA256 `ada19e89724e7cd83676b9fb45e9e7921cc9f112a4fbf7fdd166ecc8592639b4`. Real backup + fenced restart PASS.
- **Validate-only Restore PASS**, включая реальное изолированное PostgreSQL replay,17 tables, pending SSD/copy checks и backend migration compatibility replay. Это не полная backend PostgreSQL integration suite318 и не historical roundtrip.
- Actual Restore повторно прошёл pre-validation, затем `RESTORE_WRITERS_STOPPED`, `RESTORE_ROOT_FENCED`.

Отказ: `recovery storage identity validation failed; no storage helper started` / `Restore storage fence lost before SQL mutation`. Receipt сохранён в phase `ROOT_FENCED`; backend/frontend/ingress остановлены, db healthy. По control flow отказ случился **до target SQL reset/replay**, staging/swap также не достигнуты. Полного Restore/historical/crash PASS нет.

### 23.2. Подтверждённая причина и исправление

В `restore.sh` оставался вызов `recovery_storage.py backup-fence-check`. В разделе20 backup capture был усилен: требует backup marker environment и запрещает любой `restore.pending.json`. При настоящем Restore receipt уже должен существовать. Поэтому данный backup-only вызов принципиально несовместим с корректной Restore transaction; добавлять фиктивный backup marker или разрешать backup во время Restore нельзя.

Это регрессия предыдущего усиления backup capture, пропущенная переносимыми shell callsite checks. Исправлено:

- Новый `restore_maintenance.py check-root TOKEN` выполняется в том же Bash parent с унаследованными FD8/FD9 до staging/SQL.
- Проверяет владение operation lock, durable restore receipt/token/snapshot и phaseROOT_FENCED, отсутствие migration permits, точные Id/Image всех исходных services, фактический root fence/OFD/identity, остановленных writers и exact inhibitor identity/payload. Receipt повторно читается после rechecks.
- `restore.sh` вызывает этот restore-specific gate вместо backup-only CLI. Отказ по-прежнему завершает операцию до SQL и оставляет writers fenced.
- `recovery_storage.py`, backup capture ownership/restore refusal, immutable host verifier/root anchors и resource/security checks не изменены этим исправлением.

Изменены только `scripts/restore.sh`, `scripts/restore_maintenance.py`, `scripts/ci/test-restore-maintenance.py`. Никаких bypass/skip для runtime admission не добавлено.

### 23.3. Проверки

Restore maintenance suite **39/39 PASS**, из них12 новых регрессий. В отдельном subprocess выполнен actual `check-root` CLI с реальными унаследованными kernel OFD/flock и существующим restore receipt, без `HOMECLOUD_BACKUP_MARKER_IDENTITY`; результат `RESTORE_ROOT_VERIFIED`. Docker inventory/host ownership/ancestry в portable fixture подставлены, реальное владение operation/root locks и inode checks выполнены.

Негативные проверки: wrong token/phase, lost operation lock, lost root lock, чужой OFD owner, replaced storage root, replaced marker, unexpected migration permit, resumed writer, replaced service identity, inhibitor payload refusal, receipt changed during check. Actual shell admission snippet при отказе не достигает SQL sentinel. Backup capture11 PASS сохраняют отказ при restore receipt.

Затем выполнен весь `bash scripts/ci/test-recovery-contracts.sh`:21 Python suites, **262 PASS /1 SKIP**, Node migration admission **9 PASS**. Итого **22 команды:271 PASS /0 FAIL /1 SKIP**. Standalone39/11 и прошлые ledger не суммируются повторно. Единственный skip — encrypted scheduled fixture без age/age-keygen.

Log `/tmp/homecloud-pr45-restore-root-contracts.log`, SHA256 `f21e0427565bbab5b56777b8daf4c3a66d9aa16c3b4c97a137264e57ab5b2ebd`. Команды/counts сохранены в JSON. Bash syntax restore.sh, Python3.9 AST changed modules/tests и git diff whitespace PASS. Source tar52 members с root0:0/nonwritable и новым check-root, SHA256 `2892f15e2bb61566e386aa0e9770fad3b3770641a14aaaa01d4b0b2e483d9386`.

Новое restore admission ещё не прошло actual-image execution или финальный независимый security review. Backend/frontend source не менялся; полные backend/native/PG/crash tests не повторялись без подходящей среды.

### 23.4. Следующий запуск и блокер среды

Read-only `docker info` снова отказал: **permission denied while trying to connect to the docker API at unix:///Users/aleksejkozemakin/.docker/run/docker.sock**. Поэтому новое исправление проверено source/portable/kernel-lock regressions, но **полный Backup→Restore остаётся pending**. Обходов sandbox/production endpoint не было.

В обычном Terminal MacBook выполнить текущие исходники, сохранив старые logs:

```bash
(
  set -euo pipefail
  cd ~/Desktop/HomeCloud
  test "$(git branch --show-current)" = "миниатюры-файлов-v1"
  env -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    -u HOMECLOUD_E2E_BACKEND_IMAGE \
    DOCKER_HOST="unix://$HOME/.docker/run/docker.sock" \
    bash scripts/ci/run-restore-e2e-local.sh linux/arm64 2>&1 \
    | tee /tmp/homecloud-pr45-e2e-restore.log
)
```

Новый marker после `RESTORE_ROOT_FENCED`: `RESTORE_ROOT_VERIFIED`; затем должны пройти stage/SQL/swap/migration/reconcile/restart, historical identity roundtrip и оба итоговых E2E PASS. Следующий отказ разбирать по новому log; не переделывать успешно подтверждённые cgroup/packaging этапы.

После полного E2E остаются обязательные318 real backend PostgreSQL tests, полный backend на Linux, native/copy recovery/maintenance/inherited-orphan root fencing/crash/ambiguous COMMIT, age/encrypted, LinuxAMD64, retained candidate CI и пункты11/14/16. B01/B02 открыты до всей qualification; validate-only replay не заменяет её.

### 23.5. Checkpoint

**NOT READY.** Manifest97 source files, новый SHA256 `08ca522100554294e1c363851c7248a83baf795a16ee7c2e13e9699986bb350f`. Предыдущий97 с hash `fa4532ea…` и ledger279/1 сохранён в JSON history; source paths не добавлялись. Новых коммитов нет, staged пуст,48 modified +54 untracked. Все исходные изменения и три посторонних первоначальных файла сохранены. Новые ветки/worktree/клоны/destructive Git/production/push/merge/deploy/release не использовались.


## 24. Реальный Backup→Restore PASS; переход к полной Linux qualification

### 24.1. Подтверждённый E2E

Входной manifest97 совпал97/97; ветка `миниатюры-файлов-v1`, HEAD `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`, base `85578280b40d485c2765e961e6ec4f591d43f02c`. Все исходные незакоммиченные изменения сохранены.

Прочитан `/tmp/homecloud-pr45-e2e-restore.log`:1429 строк,42831 bytes, SHA256 `66f0ca2909061b565015cebb9dbdcbc40f3132309dcfcf4638c90670a18d31e4`. Запуск пользователя в обычном Terminal на исходниках checkpoint23.

Backend manifest list `sha256:3a817013b38cbfcb2932c1350e302b458e5ee01054910977e9a45ec8e9421c01`, content manifest `sha256:c10907214fd2a96830f5fa86b310783708dd80755c70cc581fd163009752dbfc`, config `sha256:e170d1d252b38b907f361e0905d6e23df20f955d7c63845d94977446ad0eb78d`. Runtime list `sha256:f93d66110df0a2f748f4cf07bfcb1a4e59351a6f823144c58212feff7f88f8f3`.

**PASS: REAL BACKUP -> RESTORE E2E** и **PASS: HISTORICAL ROOT IDENTITY BACKUP -> RESTORE** в полном логе присутствуют. Реально пройдены:

- Trusted helper image preflight, private cgroup delegation и kernel memory/CPU/PID resource probe.
- Production startup disk gate, enrollment storage identity, real PostgreSQL16.15/backend/API register/login/upload.
- Exclusive storage fence, dump/storage archive checksums и metadata sidecar, atomic backup publication, fenced restart.
- Validate-only PostgreSQL replay и backend migration compatibility.
- Actual Restore: operation lock, stopped writers, inherited root fence, новый `RESTORE_ROOT_VERIFIED`, durable storage staging до SQL, transactional SQL restore, checkpointed storage swap, authorized maintenance migration, reacquisition fence, reconcile, exact original containers restart, HTTP health/ack.
- Во втором полном Restore — старый archive layout с canonical root `.homecloud-storage-identity` как проверяемой metadata. Исходный backup не менялся, target storage identity сохранена.
- В обоих циклах скачаны точные исходные bytes; after-backup файл отсутствует; containers/storage identity/quota/journal согласованы; inhibitor/receipt/staging/swap/permit artifacts отсутствуют. Reconcile дважды OK, все шесть error/drift counters равны0. В конце четыре services healthy.

Backup ID `20261113_104020_7ac233eb`; DB SHA256 `3d64d045df5b64b196b670042e76a1564155160a865436f9a337ced9c2f2f4f9`, storage SHA256 `649933b09c6038d7da054ef76ee9778efc02fc706929a9caa8f525dd9ca82d3a`.

Это закрывает конкретные runtime failures разделов21–23. **Это не полная PostgreSQL integration suite318, не fault matrix и не историческая DB schema7..15 qualification.** Historical fixture использует текущую schema17 с историческим архивным root marker. Frontend/ingress в core E2E — stubs, DB/storage находятся на одном disposable ext4; это не полный deployment/browser тест.

### 24.2. Следующий этап сделан конкретным: единый local runner

Новый `scripts/ci/run-pr45-qualification-local.py` готовит и последовательно выполняет9 проверок на текущих исходниках:

1. Полный backend unit route в freshly built Linux builder, Jest как UID/GID1000.
2. Disposable PostgreSQL в tmpfs/internal network; actual `SHOW server_version` обязан вернуть16.15.
3. Полный integration route, включая PostgreSQL/native filesystem/concurrency/bench и реальные SIGKILL/ambiguous-COMMIT сценарии из существующих suites.
4. Node inherited/orphan root fence, maintenance supervisor и operator CLI runtime suites.
5. Linux root ownership/flock/storage SIGKILL tests.
6. Encrypted backup focused suite с actual `age`/`age-keygen`.
7. Scheduled HTTP/encrypted suite с actual age.
8. Production image maintenance supervisor Docker suite.
9. Production image copy recovery с настоящей PostgreSQL и всеми существующими negative/concurrency cases.

Runner фиксирует local Docker Desktop socket; проверяет branch/HEAD/source manifest до/после; собирает backend builder и production runner заново, получает immutable image IDs через build `--iidfile` и проверяет architecture. Unit/integration не получают Docker socket или host mounts. Docker networks/containers только disposable, host ports отсутствуют, privileged containers runner не создаёт. Chown/drop UID происходят только внутри тестового builder container. PostgreSQL integration не использует существующие базы. Copy recovery script сохраняет собственный pinned AMD PostgreSQL image, даже при native ARM backend.

Новый `pr45-qualification-tools.Dockerfile` добавляет actual age только в disposable Linux tool image. Расширение `restore-e2e-context.py` разрешает явные relative extra paths и другой Dockerfile для этого tool context, сохраняя прежний default. Default E2E tar **byte-identical** к уже выполненному candidate: SHA256 `2892f15e2bb61566e386aa0e9770fad3b3770641a14aaaa01d4b0b2e483d9386`; production E2E source не менялся. Tool archive allowlisted/root0:0/nonwritable; runner base строится из Dockerfile-only stdin, без отправки root repository context с env/Git metadata.

Перед Jest удаляются только два известных report path внутри disposable builder; stale report не может квалифицировать новый запуск. Raw Jest JSON сохраняется. Проверка переиспользует actual `test-routing.py verify`, меняя только `/app/...` source paths на реальные workspace paths в копии отчёта. Assertions/statuses не меняются; missing/duplicate/failed/empty/skipped suite/assertion отвергается. Integration обязан подтвердить минимум318 PostgreSQL assertions. Отказ одного независимого этапа записывается и не отменяет оставшиеся проверки; итоговый PASS требует всех9 этапов, неизменного source snapshot и успешного cleanup. Таймаут attached Jest command30min — FAIL, forceExit/skip flags не добавлены.

Reports: новый `/tmp/homecloud-pr45-qualification-<arch>.<token>/qualification.json`, raw Jest reports и per-stage logs. Это test evidence, не дополнительная Git working copy. Runner поддерживает ARM64/AMD64; при AMD на ARM Docker фиксирует engine architecture, emulation не считается native hosted AMD CI. Local runner не подменяет retained OCI release/supply-chain qualification.

### 24.3. Проверки harness и фактический sandbox отказ

Новый `test-pr45-qualification.py` **12 PASS**: strict unit/integration report gates, zero skipped, minimum318 PG assertions, invalid/traversal/missing/duplicate/failed report refusal, cleanup только owned IDs/network, cleanup failure и source change не дают PASS, reports сохраняются, extra paths не выходят из repo, actual tool context сохраняет Linux metadata/allowlist. Синтетические fixture PASS/counts скрыты из stdout, чтобы не путать с настоящими test results.

Полный portable recovery driver:22 Python suites **274 PASS /1 SKIP**, Node9 PASS. Дополнительно CI gate5 и policy coverage15. Итого **25 команд:303 PASS /0 FAIL /1 SKIP**. Это не сумма с предыдущими ledger. Единственный skip — age scenario на Mac; для его qualification нужен новый actual Linux tool container. После iidfile binding целевые qualification12/context8 повторены PASS без двойного подсчёта.

Log `/tmp/homecloud-pr45-qualification-contracts.log`, SHA256 `9d844b607c31b66f6f22192159afaf65a56df2aeea5c405440681824c583659c`. Python3.9 AST changed/new modules, Bash syntax recovery driver, git whitespace PASS.

Попытка **actual нового runner** в текущей сессии: exit1 на первом `docker info --format` с **permission denied while trying to connect to the docker API at unix:///Users/aleksejkozemakin/.docker/run/docker.sock**. Evidence `/tmp/homecloud-pr45-qualification-arm64.j666he4m/qualification.json`: complete=false, checks=[], images={}, cleanup_errors=[]. Выполнено0 qualification tests, построено0 images, запущено0 containers. Этот NOT PASS не заменён portable/mocked результатами.

### 24.4. CI/TEST и дальнейшие обязательные gates

Read-only GitHub recheck: PR45 open/draft, remote head/base прежние,43 published changed files. Workflow runs42828127020/42828126813/42828126997 success относятся только к опубликованному ee84ddd6; новые рабочие изменения ими не квалифицированы. Ни push, ни запуск публикации/установки не выполнялись. Проверены фактические CI wiring: full unit/integration routes, Linux inherited/orphan runtimes, Linux restore crash, age, production copy recovery/maintenance и retained backend candidate для AMD64 E2E. Host verifier/root anchors остаются byte-identical HEAD; разрешение изменённых deploy-файлов не добавлено.

После ARM64 runner необходимо разбирать actual failures, подтвердить всю crash/ambiguous-COMMIT matrix и TEST lifecycle в разрешённом disposable scope, затем AMD64/native CI и exact candidate binding. Старые DB schema7..15 требуют отдельной runtime qualification. B01/B02 не закрываются только successful core E2E. Полные backend Linux/PG/native/encrypted результаты пока pending. Новых коммитов нет до обязательной qualification; final independent review exact final HEAD впереди.

### 24.5. Минимальная следующая команда для обычного Terminal

Повторять уже успешный E2E без причины не требуется. Запустить оставшиеся gates одной командой:

```bash
(
  set -euo pipefail
  cd ~/Desktop/HomeCloud
  python3 -B scripts/ci/run-pr45-qualification-local.py linux/arm64 2>&1 \
    | tee /tmp/homecloud-pr45-qualification.log
)
```

Runner сам выбирает local Desktop socket; не нужны ручные правки env/файлов. В конце выводит `REPORTS: ...`. Для продолжения читать fixed `/tmp/homecloud-pr45-qualification.log`, затем qualification.json и соответствующие failed-stage logs. `PASS: LOCAL LINUX QUALIFICATION` означает прохождение именно9 описанных local gates, не финальный READY всего PR. При ошибке setup/build сохранить этот log и каталог reports; не начинать исправления PR заново.

### 24.6. Checkpoint

**NOT READY**, при этом реальный core Backup→Restore и historical root marker roundtrip **PASS**. Manifest теперь100 source files, SHA256 `3d4927054fd7f174e5f308a15e90d85049418317661ef15185db6775ccf9b208`. В JSON history сохранены прежний97 и ledger271/1, input E2E SHA/digests и текущее состояние. Production/backend/frontend code этим продолжением не менялся; добавлены3 qualification files, изменены context helper и test driver.

Ветка/HEAD прежние, staged пуст,48 modified +57 untracked;3 первоначальных посторонних файла сохранены. Новые ветки/worktree/клоны/destructive Git/production/push/merge/deploy/release не использовались. Новых коммитов нет; все исходные изменения сохранены.


## 25. Реальная Linux ARM64 qualification: product tests PASS, scheduled fixture rerun

### 25.1. Вход и оригинальные evidence

Ветка `миниатюры-файлов-v1`, HEAD `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`; manifest100 совпал100/100, staged пуст, прежняя работа сохранена. Пользователь выполнил новый qualification runner в обычном Terminal.

Основной log `/tmp/homecloud-pr45-qualification.log`:1686 строк,102745 bytes, SHA256 `976650cd1ac85ca1cc7d7632f51472c9b91729e5d7ee87d253b29ef31827fb6e`. Actual report directory `/tmp/homecloud-pr45-qualification-arm64.zcpwadth`; исходный snapshot `3d4927054fd7f174e5f308a15e90d85049418317661ef15185db6775ccf9b208`. Engine29.4.1/Linux/aarch64, реальный PostgreSQL16.15 в отдельном tmpfs/internal network. Cleanup errors отсутствуют.

Исходный qualification.json **complete=false сохранён без изменений**: integration gate ошибочно требовал318 PG-only assertions; scheduled tool image не содержал двух зависимостей. Это не product suite failures.

| Реальный этап | Результат |
|---|---|
| Полный backend unit, Linux UID/GID1000 |80 suites, **1149 PASS /0FAIL /0SKIP** |
| Полный integration route, настоящий PG16.15 |33 suites, **427 PASS /0FAIL /0SKIP** |
| PG subset внутри integration |19 suites, **317 assertions PASS** |
| Bench subset внутри integration |14 suites, **110 assertions PASS** |
| Native inherited/orphan fence + operator CLI |**13 PASS /0FAIL /0SKIP** |
| Linux ownership/flock/storage parent+writer SIGKILL |**2 PASS** |
| Encrypted focused suite, actual age |**34 PASS** |
| Maintenance supervisor, production image |**5/5 PASS** |
| Real copy recovery, production image + actual PG |**5/5 PASS** |
| Shared backup/restore recovery SQL guard |**8/8 PASS** |
| Original restore validator, actual SQL/dump replay |**7/7 PASS**, включая historical15-table acceptance |
| Scheduled HTTP/encrypted |**20 PASS /2ERROR /0SKIP**, fixture fixes ниже |

Raw unit report SHA256 `06d1e037a4c1da1414f642e8cbf9578cf44312ab71825a7c1f69d44a1c9a8cf8`; raw integration SHA256 `efbf9f3d0829eb74ddddee0f36704038c43fd94fe7c610a8eac99cf8854f4520`. Все stage log hashes и actual image IDs сохранены в JSON runtime_qualification.

Builder IID `sha256:d9450aa7b1410df67b1aba40dfa0aebb30ee0249071f728a2be7d86c77b82c64`, runner IID `sha256:aabc27e007d0ec7c5645a5c7178b4365a8d0d8590ee110804b2554dffd502762`, native PG image `sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685`, прежний tool IID `sha256:82c8149ebaeb114ffd35a75dc3ad8fd0dacd6d50e7977fe3101119b953be4f72`.

### 25.2. Исправлена ошибочная классификация прежних318 skips

Сверены все raw assertions, source conditional и исторические totals. На Mac было109 PASS +318 SKIP, total427. Actual Linux:317 PG assertions +110 bench assertions =427 PASS. `backend/bench/copy-file-runner.spec.ts:59` содержит единственный Linux-only bench case — `invokes production FilesService with secure Linux storage`. Поэтому прежние318 пропусков — **317 PostgreSQL +1 native production-copy benchmark**, а не318 PG-only. Термин в предыдущих разделах был неточным; исторические отчёты оставлены как история.

Новый gate сохраняет обязательность **всех318 прежних skips**: full route/exact suite identity/nonempty/zero-skipped assertions через actual test-routing.py verify; минимум317 PG assertions плюс **точно идентифицированный passed native copy assertion** в правильном suite; суммарно минимум318 legacy skipped assertions. Повышенное PG количество не может заменить отсутствующий native test. Gate не отключён и не заменён простым снижением числа.

Actual unit/integration raw JSON повторно проверены новым gate **без повторного запуска suites и без изменения оригинальных файлов**. Integration принят как PASS_REVALIDATED_RAW_REPORT. Backend paths38 из manifest не менялись с первого report с318 skips; current product source также не менялся. Старый wrapper FAIL сохранён в runtime_qualification.original_checks; новая revalidation записана отдельно.

### 25.3. Подтверждённые fault/runtime сценарии

Actual PostgreSQL JSON подтверждает PASS:

- отмена до COMMIT откатывает metadata, отмена после COMMIT сохраняет committed copy;
- before/after COMMIT acknowledgement failure в настоящей PostgreSQL, durable journal reconciliation;
- committed admission при потерянном ACK, rollback admission, unavailable reconciliation сохраняет uncertain reservation;
- real SIGKILL на фазах reserved/claimed/unlinked, сохранение ожидаемого reservation/claim/inode state;
- offline recovery fsync failure, committed release после lost ACK, rollback recovery COMMIT, конкурирующий root flock, чужой user path и metadata/inode refusal;
- реальный orphan inherited root lock, root lock release после успешного COMMIT и Linux storage parent/writer SIGKILL сохраняют old/new bytes.

ACK failure контролируемо инъецируется вокруг настоящего commit; это не network partition или power-cut тест. Оставшиеся обязательные fault points разделов11/14/16 нужно сверить индивидуально; не считать эту таблицу доказательством всех возможных отказов. Успешные core/historical E2E раздела24 сохранены.

### 25.4. Scheduled fixture: реальные причины и изменения

Два errors из22:

1. `test_cert_real_expiry_mapping_and_recovery`: `FileNotFoundError: openssl` — tool image имел libssl/age, но не OpenSSL CLI.
2. `test_units`: отсутствовал `/opt/homecloud/ops/systemd/homecloud-backup.timer` — allowlist tool context не включал committed timer/service fixtures.

Исправлен только qualification harness: tool Dockerfile явно устанавливает `age openssl`, проверяет `openssl version` и обязательный timer; source context добавляет все8 `.service/.timer` из ops/systemd с прежними canonical/root-owned/nonwritable правилами. Product scheduler/backup/restore/backend/deploy code не менялся.

Добавлен **`--scheduled-only`**: rebuild только tool image и scheduled22 tests, без backend/PG/native/copy повторов. Metadata scope=`scheduled-http-encrypted`, scope_complete отражает только эту проверку, **complete всегдаfalse**, полного qualification PASS целевой запуск не печатает. Для full режима теперь проверяется точный набор9 unique stage names. Scope/cleanup/source change regressions это подтверждают.

### 25.5. Регрессии и доступность среды

Qualification helper **16/16 PASS**: прежние12 и новые317PG+1native boundary, missing native refusal, targeted success не даёт full PASS, targeted prepare не запускает backend/PG. Context regression проверяет наличие всех8 systemd files. Actual raw unit1149 и integration427 revalidation PASS.

Portable recovery driver:22 Python suites **278 PASS /1 SKIP**, Node9 PASS, CI gate5 и policy15. **25 команд:307 PASS /0 FAIL /1 SKIP** — отдельный ledger, реальные Docker results не прибавляются. Skip только age scenario на Mac; actual age fixture в Docker уже выполнялся, там0 skips и два известных fixture errors. Log `/tmp/homecloud-pr45-qualification-fix-contracts.log`, SHA256 `4e7be74f3171edf8d046cb576dd40c5afaf41a414ec46e43dc012e63ceb145db`.

Python3.9 AST, whitespace, default E2E tar byte-identical к passed candidate2892f15e… — PASS. Immutable host verifier/root anchors и product sources совпадают с предыдущим checkpoint.

Попытка нового targeted runner этой сессией: exit1 на первом Docker info — **local Desktop API permission denied**. Report `/tmp/homecloud-pr45-qualification-arm64.axp3ux6g`: scope_complete=false, complete=false,0 checks/0 image builds/0 containers. Новые OpenSSL/systemd fixtures ещё не выполнены реально.

### 25.6. Следующая минимальная команда

Успешные backend/PG/native/crash/cipher/copy/maintenance этапы **не повторять без новой причины**. Запустить только оставшийся scheduled suite в обычном Terminal MacBook:

```bash
(
  set -euo pipefail
  cd ~/Desktop/HomeCloud
  python3 -B scripts/ci/run-pr45-qualification-local.py linux/arm64 --scheduled-only 2>&1 \
    | tee /tmp/homecloud-pr45-qualification-scheduled.log
)
```

Ожидается22 tests без skipped/errors и `PASS: SCHEDULED HTTP ENCRYPTED QUALIFICATION`. Далее прочитать новый report; сопоставить с сохранёнными8 successful этапами (integration revalidated отдельно), не заменять исходный полный report выдуманным complete=true. Следующие gates: LinuxAMD64/native CI/retained OCI, TEST full lifecycle с immutable trust boundary, historical DB schema matrix, оставшиеся explicit fault points и final independent review/логические коммиты. Только после них READY.

### 25.7. Checkpoint

**NOT READY**, но core/historical E2E, full Linux unit, real PG+integration, native/fault/cipher/copy/maintenance подтверждены в указанном scope. Manifest100 source files, SHA256 `4e459f289dd5ebe539cdff92def3d3bf857bbf9b37f9d9f71b3ce62a0a1eb3e6`. Прежний100/3d492705… и результаты303/1 сохранены в JSON history. Изменены только три qualification files; production и immutable verifier не менялись.

Git:48 modified +57 untracked, staged пуст, новых коммитов нет; branch/HEAD прежние. Вся исходная работа и первоначальные три посторонних файла сохранены. Новые ветки/worktree/клоны/destructive Git/production/push/merge/deploy/release не использовались.


## 26. Scheduled22 PASS; архитектура tooling и переход к AMD64

### 26.1. Реальный scheduled результат

Manifest100 совпал100/100, ветка/HEAD прежние. Прочитан `/tmp/homecloud-pr45-qualification-scheduled.log` и отдельный report `/tmp/homecloud-pr45-qualification-arm64.npunl3m4/qualification.json`. Actual source snapshot `4e459f289dd5ebe539cdff92def3d3bf857bbf9b37f9d9f71b3ce62a0a1eb3e6`.

**Scheduled HTTP/encrypted22/22 PASS,0FAIL,0SKIP.** Исполнены real OpenSSL certificate/expiry mapping, controlled loopback HTTP failure/recovery delivery, actual age-encrypted fixture и чтение всех systemd timer/service units. Scope=`scheduled-http-encrypted`, scope_complete=true, **complete=false** корректно сохраняет ограниченный scope. Cleanup errors отсутствуют. Report не подменён full qualification PASS.

Stage log SHA256 `ce20758246c161bd46a0d7af864056e286c703ef85bbdadb231f430b5c3bb74f`; tool build log SHA256 `8453e358e88ded173bd6d07699accbf6c3b47e7da50b56eaac962f2870fa2510`; image ID `sha256:d083c4efc45c2ee254d182b447679edf91c029723cd52ab24677e687475ce6b2`. Полный report/terminal hashes сохранены в JSON.

Вместе с предыдущим полным прогоном подтверждены все9 local gates: unit1149, integration427 (317PG+110bench; все318 прежних skips), native/orphan13, Linux storage/crash2, age34, scheduled22, maintenance5, copy5 + guard8 + SQL validator7. Это **evidence нескольких прогонов с неизменным product source**, не новый выдуманный complete=true у оригинального full report. Core/historical E2E PASS сохранены.

### 26.2. Реальный platform mismatch и его границы

В полном и targeted build logs присутствует BuildKit `InvalidBaseImagePlatform`: pinned Debian Node и Compose manifest в `restore-e2e-runner.Dockerfile` относятся к **linux/amd64**, прежний caller передавал **linux/arm64**. Builder выдавал final image metadataARM64, несмотря на AMD64 bases. Поэтому metadata из Docker inspect недостаточно для утверждения actual executable/native CPU architecture.

Linux/kernel/crypto/HTTP результаты сохраняются. Но Python/root tooling результаты не объявляются **CPU-native ARM64**. Product backend использует другой Alpine builder/runner, в его build log таких warning нет; точный executable/native-addon ARM evidence всё равно дополнительно запрашивается, вместо предположения по metadata.

Исправлен только fixture/harness:

- Qualification tooling build/run явно **linux/amd64**, что соответствует существующим checksum-pinned bases. Product builder/runner/PostgreSQL остаются на запрошенной платформе.
- Перед product tests builder/runner дополнительно выполняют read-only Node probe: `process.platform`, `process.arch` и успешная загрузка actual `native/secure-fs.node`. Несоответствие requested platform — немедленный отказ, одной image metadata недостаточно. Probe не запускает API и не получает mounts/network/capabilities.
- E2E launcher отделяет `TOOL_PLATFORM=linux/amd64` от backend platform, проверяет base runner metadata до build и использует правильную platform для runtime/preflight/nested fixture. Trusted production files/host verifier не менялись. Уже выполненный source tar остаётся byte-identical2892f15e…; меняется только packaging architecture declaration.
- Новый read-only режим **`--probe-existing REPORT_DIR...`** читает сохранённые immutable IID files, требует прежние branch/HEAD и одинаковые backend source hashes. Проверяет product Node/native addon и собирает фактическую архитектуру старых tools. Он не пересобирает images и не повторяет suites. Tool metadata/runtime mismatch записывается как evidence, а не как подтверждённый native ARM PASS. Полный qualification PASS в этом scope невозможен.
- При AMD64 profile на ARM Desktop отчёт фиксирует Engine aarch64 и product executableAMD64; это cross-architecture execution, не native hosted AMD runner. Native CI/retained OCI qualification остаётся отдельным gate.

### 26.3. Проверки этого изменения

Qualification harness **20/20 PASS**: четыре новые проверки actual executable/addon vs metadata, same-source checks, independent tooling platform и unknown scope refusal. Context8, CI gate5, policy15, Bash syntax и Python3.9 AST PASS. Полный portable driver:22 Python suites **282 PASS /1 SKIP**, Node9; вместе с CI5/policy15 **25 команд:311 PASS /0FAIL /1SKIP**. Ledger не складывается с actual Docker results/старыми прогонами.

Log `/tmp/homecloud-pr45-platform-contracts.log`, SHA256 `c62a29d7a3274322a9f972682fb5303a83c8417acac404d4398bfbbf4240ac88`. Последние qualification20/context8 повторены после base metadata preflight, без двойного подсчёта. Product sources и immutable verifier/root anchors не изменены.

Попытка retained probes здесь: exit1 на первом local Docker info, **permission denied** для `/Users/aleksejkozemakin/.docker/run/docker.sock`. Report `/tmp/homecloud-pr45-qualification-arm64.psu0i0q5`,0 probes/0 builds/0 containers. Новые executable probes и AMD64 profile этой сессией не выполнены.

### 26.4. Следующая команда MacBook

Сначала снять архитектуру сохранённых ARM product images без повторения successful suites, затем выполнить следующую AMD64 qualification:

```bash
(
  set -euo pipefail
  cd ~/Desktop/HomeCloud
  python3 -B scripts/ci/run-pr45-qualification-local.py linux/arm64 \
    --probe-existing /tmp/homecloud-pr45-qualification-arm64.zcpwadth \
    /tmp/homecloud-pr45-qualification-arm64.npunl3m4 2>&1 \
    | tee /tmp/homecloud-pr45-platform-evidence.log
  python3 -B scripts/ci/run-pr45-qualification-local.py linux/amd64 2>&1 \
    | tee /tmp/homecloud-pr45-qualification-amd64.log
)
```

Если executable probe product images не совпадёт с ожидаемой ARM platform, команда остановится до затратного AMD profile. В platform evidence JSON смотреть role, metadata_platform, runtime_platform, native_addon_loaded и fixture_metadata_mismatch. Старые mixed-metadata tooling images разрешены только как объект read-only наблюдения; новые images обязаны иметь честную tooling platform.

После AMD читать оба fixed logs и соответствующие report directories. Не объявлять AMD execution native hosted CI, не менять production pins ради допуска нового platform. Сохранять все original reports.

### 26.5. Что ещё обязательно до READY

- Explicit architecture evidence и AMD64 profile; exact retained OCI/native hosted CI остаётся pending без публикации текущего source.
- TEST lifecycle и host recovery wrapper, включая общий operation lock и cross-container writer inventory: actual CLI/copy/maintenance PASS и portable source contracts есть; полный host/install scope ещё не подтверждён. Immutable deployment boundary не ослаблять ради modified deploy files.
- Historical root marker full roundtrip PASS, actual15-table validator PASS; supported old DB schema7..15 restore/migration matrix ещё не считается выполненной.
- Сверить по текущим source/tests все пункты11/14/16: staging-before-SQL, partial admission failure, RECONCILED/swap cleanup, READY/restart windows, permit inode/BigInt binding, all-writer fence, raw backup lock capture, physical identity и bounded restart. Существующие PG ACK/SIGKILL, Linux parent/orphan и common E2E доказательства не заменяют отсутствующие specific fault points.
- Encrypted focused34 и core real Backup PASS выполнены отдельно; combined real production encrypted coordinator lifecycle надо отличать от protocol suite с raw-backup fixture stub.
- Logical commits/final exact HEAD independent review; push/merge/deploy/release отдельно не разрешены.

### 26.6. Checkpoint

**NOT READY**. Manifest100, SHA256 `418e871a4254d297c5676dea3edefa94895e2b11e8e6814cd2833287c230fe0d`. Previous100/4e459f28… и portable307/1 сохранены в JSON history. Изменены только qualification helper, его tests и E2E launcher platform declaration; ни backend, ни production recovery/restore/security guard source не менялись.

Git: ветка `миниатюры-файлов-v1`, HEAD `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`, staged пуст,48 modified +57 untracked, новых коммитов нет. Вся исходная работа и3 первоначальных посторонних файла сохранены; новые ветки/worktree/клоны/destructive Git/production/push/merge/deploy/release не использовались.

## 27. ARM product executable/addon PASS; obsolete tooling не блокирует AMD64

### 27.1. Фактический отказ и уже полученное доказательство

Manifest100 совпал100/100, branch/HEAD прежние, staged пуст. Прочитаны полный stage log и JSON `/tmp/homecloud-pr45-qualification-arm64.nd3ld1_w`.

Report source snapshot `418e871a4254d297c5676dea3edefa94895e2b11e8e6814cd2833287c230fe0d`; Engine29.4.1/Linux/aarch64. Два product probes **реально завершились успешно** до последующей ошибки:

| Role | Actual image ID | Docker metadata | Executable | Secure native addon |
|---|---|---|---|---|
| builder | `sha256:d9450aa7b1410df67b1aba40dfa0aebb30ee0249071f728a2be7d86c77b82c64` |linux/arm64|Node linux/arm64|loaded=true|
| production runner | `sha256:aabc27e007d0ec7c5645a5c7178b4365a8d0d8590ee110804b2554dffd502762` |linux/arm64|Node linux/arm64|loaded=true|

Backend source identity повторно сверена с report и current manifest: branch/HEAD и backend hashes совпадают. ARM product executable/native-addon evidence установлено. Повторять unit1149/integration427/native13 и эти product probes ради диагностического wrapper PASS не требуется.

После двух успешных probes stage попытался inspect старый tool ID `sha256:82c8149ebaeb114ffd35a75dc3ad8fd0dacd6d50e7977fe3101119b953be4f72` и получил **No such image**. Причина исчезновения image не установлена; недоступен устаревший fixture artifact, product executable/native addon не отказывали. Из-за pipefail AMD64 command **не запускалась**.

Оригинальный report сохранён со statusFAIL/scope_complete=false, не переписан в PASS. Actual execution_probes и image fields двух product IDs отдельно проверены. Report SHA256 `b1937e54fd5498484a9b2d87db13fec8d3ee1d2ae9f8a12237ea2f4b61807cd4`; stage log SHA256 `11df0603af864ae305bbd420d22b485156ad53f75386dcfa62cc67d113b4a101`.

### 27.2. Harness fix и регрессии

`--probe-existing` теперь устанавливает product architecture по **builder и runner**. Оба role обязательны; проверки source/branch/HEAD, immutable IID syntax, metadata platform, actual Node arch и загрузки secure-fs.node сохранены. Недоступный product image остаётся фатальным отказом. Generic exception swallowing или допуск wrong architecture не добавлены.

Устаревшие tool images больше не являются prerequisite product architecture proof и не запускаются этим probe. Текущий tooling independently фиксируется/проверяется linux/amd64 при build/run по разделу26. Native ARM для старых tools не утверждается.

Новые2 regressions проверяют отсутствие обращения к obsolete tooling и отказ при недостающем builder/runner. Qualification **22/22 PASS**, context8 PASS. Полный portable driver:22 Python suites **284 PASS /1 SKIP**, Node9, CI gate5 и policy15. **25 команд:313 PASS /0FAIL /1SKIP**. Standalone/previous runs не прибавляются повторно. Log `/tmp/homecloud-pr45-product-platform-contracts.log`, SHA256 `c5ee22c3e20b1a1b56d3db7c3f162ca44e1fbfa2d7c84588c379ff6ad3130377`.

Python3.9 AST, whitespace и actual partial-report product fields offline revalidation — PASS. Изменились только qualification helper/tests; backend, production recovery/security guards, CI workflows, E2E source и immutable verifier/root anchors не менялись этим исправлением.

### 27.3. Следующий шаг — только AMD64

Не повторять успешную ARM qualification и probes. В обычном Terminal MacBook:

```bash
(
  set -euo pipefail
  cd ~/Desktop/HomeCloud
  python3 -B scripts/ci/run-pr45-qualification-local.py linux/amd64 2>&1 \
    | tee /tmp/homecloud-pr45-qualification-amd64.log
)
```

Runner собирает текущий AMD64 backend, проверяет executable/native addon и выполняет9 local gates с PostgreSQL16.15. Tool image теперь честно AMD64. На aarch64 Engine это cross-architecture execution, не native hosted AMD CI. При unsupported syscall/ABI не ослаблять native filesystem/security checks; разбирать actual evidence.

Попытка этой сессией: `/tmp/homecloud-pr45-qualification-amd64.vwgwf_mi`, exit1 на первом Docker info из-за **permission denied local Docker Desktop API**.0 checks/0 builds/0 containers. Не путать sandbox refusal с реальным пользовательским ARM probe run.

### 27.4. Checkpoint и оставшиеся gates

**NOT READY.** ARM product architecture подтверждена отдельно; core/historical E2E, ARM Linux unit/PG/native/crash/cipher/copy/maintenance/scheduled результаты сохранены. Дальше AMD64 profile, native/exact retained OCI CI, TEST host lifecycle/remaining fault audit, actual historical DB matrix, combined production encrypted Backup lifecycle, logical commits и final independent review.

Manifest100, SHA256 `1bece563a2e612ce314b00f0c26df5c7d1e90089817ba76574550b290f07cab8`; предыдущий100/418e871a… и portable311/1 сохранены в JSON history. Product proof — `platform_qualification.native_arm64_product_evidence`.

Ветка `миниатюры-файлов-v1`, HEAD `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`, PR45/base прежние; staged пуст,48 modified +57 untracked, новых коммитов нет. Все изменения и3 первоначальных посторонних файла сохранены. Новые ветки/worktree/клоны/destructive Git/production/push/merge/deploy/release не использовались.

## 28. AMD64 runtime FAIL, functional syscall gate и production encrypted E2E

### 28.1. Что фактически завершилось

Перед изменениями manifest100 из27 совпал100/100; branch/HEAD прежние. Полностью прочитаны сохранённые stage logs и исходный report `/tmp/homecloud-pr45-qualification-amd64.1izbhl0_/qualification.json`. Исходные отчёты не переписаны.

Source snapshot `1bece563a2e612ce314b00f0c26df5c7d1e90089817ba76574550b290f07cab8`; Engine29.4.1/Linux/aarch64, requested product linux/amd64. Node реально сообщил x64 и загрузил addon в builder `sha256:00288ffb8d7c3cb49a4e3e6caad8952ef37f862f78c95b535e5ae3a4540f9b93` и runner `sha256:1294e71a059b6f2074fda991037f187d170e248db5af7bf9d71cd9944eec7f90`. Это не доказало работоспособность его операций.

| AMD64 stage | Фактический результат |
|---|---|
| Full backend unit | FAIL; JSON не создан, итоговые количества не установлены; native ENOSYS и последующие worker/cleanup ошибки |
| PostgreSQL prerequisite | PASS, actual16.15 |
| Full integration | 33 suites:23 PASS/10 FAIL;427 assertions:272 PASS/155 FAIL/0 SKIP |
| Inherited/orphan/operator fence |13 tests:4 PASS/9 FAIL/0 SKIP; ENOSYS при native root |
| Linux storage crash |2 PASS |
| Encrypted protocol/age |34 PASS; raw child scripts — fixtures, не combined production coordinator |
| Scheduled HTTP/encrypted |22 PASS/0 SKIP |
| Maintenance supervisor | FAIL в первом positive case; отдельного подробного error в stage log нет |
| Production copy recovery | FAIL: `STOP: fenced backend startup failed: Function not implemented` при actual migrations |
| Runner-owned cleanup | `cleanup_errors=[]`; full/scope_complete=false |

Full log `/tmp/homecloud-pr45-qualification-amd64.log`:9040 lines/486550 bytes, SHA256 `171a45e2e20d240b16ef82fe5efca548fc6e01569a66193ee8af2ca47f2c5cae`. Report SHA256 `314d96f99720ba10a13edb5af97ad94d9138689e86134e95989d8014fcce6084`. Raw integration report SHA256 `77fc6a2be3c8f52c9b592ef4b6660db1547f4586c18a71d4ed017eb4145c18e4`. Все стадии, counts и hashes дополнительно сохранены в JSON evidence.

Прослежен вызов `SecureFilesystem -> native().root -> backend/native/secure-fs.c -> syscall(SYS_openat2, ...)`. Production C не менялся. Ошибка ENOSYS подтверждена; какая именно прослойка возвращает её, ещё не доказано. AMD execution на aarch64 Engine и успешный ARM native run указывают на возможное ограничение cross-architecture среды; это гипотеза до независимого syscall probe. Rosetta/QEMU version/settings не установлены. Попытка read Docker Desktop settings получила Operation not permitted; настройки не менялись. Ни syscall fallback, ни отключение seccomp/security checks не добавлены.

### 28.2. Что исправлено в qualification и CI

- `scripts/ci/native-boundary-preflight.cjs`: в disposable container без host mounts создаёт private temporary root, загружает actual addon, открывает root/directory, сверяет dev/ino через BigInt, берёт native flock и закрывает descriptors. Одна загрузка addon больше не достаточна. В main/Node-e режиме печатает структурированный JSON; `--strict` завершает CLI с отказом при неработающей границе.
- Отдельная C-программа, собранная target compiler внутри builder, вызывает raw openat2 с минимальными и production strict flags. Использует target Linux headers/SYS_openat2; фиксированные syscall numbers не подставляются. Compiler отсутствует в production runner — это диагностируется отдельно; actual native root/directory/lock обязательны в обоих role. Этот C probe в AMD контейнере ещё не выполнен.
- Qualification сохраняет execution_probes до отказа, затем fail-closed требует `nativeBoundaryOperational=true`. Это останавливает full profile на prepare до сотен заведомо бесполезных native failures. `--probe-existing` применяет тот же gate к retained exact image IDs без rebuild/PG/suite rerun.
- `.github/workflows/ci.yml`: строгий preflight и plain+encrypted E2E используют тот же retained `homecloud-ci-backend:${{ github.sha }}`; второй product build не добавлен. Scan/archive/manifest/config binding и immutable host verifier/root anchors не изменялись. Эти новые workflow steps локально проверены как source, но ещё не исполнялись hosted CI.

### 28.3. Подготовлен combined production encrypted coordinator E2E

`run-restore-e2e-local.sh linux/arm64 --encrypted-only` запускает fresh isolated nested daemon/ext4 с actual backend/PG/API/startup gate/fencing. Новый режим вызывает **настоящие** `backup-production.sh` и `restore-offsite.sh`, а не stub raw children:

1. Seed через API; реальные writers работают перед admission.
2. Private age identity/recipients создаются только в disposable runtime `/tmp`, вне source/storage/backup roots; secret key0600. Tooling base дополнен age.
3. Production coordinator сам получает общий operation lock/backup window, останавливает writers, создаёт raw backup, шифрует и публикует локально и в отдельном fixture offsite directory.
4. Проверяются success marker/generation, byte equality local/offsite ciphertext+manifest, age header и отсутствие plaintext/production lock residue.
5. Реальные данные изменяются через API. Offsite validate-only должен оставить after-backup record; затем выполняется actual encrypted restore.
6. Повторно используется установленная core E2E проверка exact downloaded bytes, отсутствия after-backup файла, quota/journal, прежних containers/storage identity, maintenance/permit/stage/swap cleanup. Проверяются encrypted validation/restore markers и plaintext cleanup.

Этот новый режим **PENDING EXECUTION**, PASS ему не присвоен. Offsite здесь — отдельный private directory в disposable container; физическая отдельная машина/носитель и реальная доставка не квалифицированы. Frontend/ingress остаются stubs, как в core E2E. Исходный plain+historical режим сохранён; повторять его сейчас не требуется.

Context tar после изменения entrypoint:52 members, SHA256 `f118a849574602b13a7f8845938de718e0d2da869e08b4c004ba61a29d3e0432`, UID/GID0:0, без group/other write bits, без age keys. Старый runtime образ не содержит нового сценария; команда28.5 пересобирает base с age и актуальный runtime/backend.

### 28.4. Обязательные fault points и доступные проверки

Добавлены3 реальных fork/SIGKILL tests в `test-restore-maintenance.py`. Они исполняют настоящий host coordinator/checkpoint filesystem, но Docker lifecycle в них mocked:

| Точка аварии | Подтверждено |
|---|---|
| После durable RECONCILED, перед swap deletion | old swap сохранён, receipt RECONCILED и inhibitor сохранены; новая maintenance отказывает |
| После durable READY, перед clear marker | swap удалён после checks; READY/inhibitor сохранены; restart не допускается |
| После clear marker, перед restart | READY receipt переживает SIGKILL, новая operation отказывает, explicit retain создаёт inhibitor и RESTART_FAILED |

Maintenance suite **42 PASS**. Это не powercut/fsync hardware test и не real Docker process-kill restart matrix.

По actual source/tests повторно сверены11.1–11.6: staging/check-root до SQL; RESTORE_ADMITTED/DESTRUCTIVE устанавливаются до begin; durable INHIBITED до stop; verify_pending/reconciliation/completion checks до RECONCILED/swap deletion; READY до marker clear, receipt до acknowledgement; token/dev/ino BigInt permit binding; TEST recovery общая lock и independent all-container writer inventory. Уже имеющиеся actual PG ACK/rollback/unknown/SIGKILL и ARM native результаты сохранены; эти source checks не объявляют pending real host/TEST lifecycle пройденным.

`bash scripts/ci/test-recovery-contracts.sh`:22 Python suites, **288 PASS/1 SKIP**, Node restore permit9 PASS и новый native preflight4 PASS. Единственный skip — host age dependency, уже отдельно квалифицированная Linux actual-age suites. Driver log `/tmp/homecloud-pr45-native-preflight-contracts.log`, SHA256 `a65d29bce495cfbecb7e83273e1551d93077c9798e2828537f82aa8c53f3c981`.

Дополнительно: CI gate5, policy coverage15, OCI binding9, immutable host verifier18, root boundary26 — **73 PASS**. Итого этот checkpoint: **29 команд,374 PASS/0 FAIL/1 SKIP**; repeated standalone runs не прибавлены. YAML обоих workflows, Python3.9 AST, Bash/Node syntax, context ownership и whitespace — PASS. Нативное Linux исполнение новых syscall и encrypted E2E из этого числа исключено.

### 28.5. Следующая минимальная операция в обычном Terminal MacBook

В exec sandbox точная заблокированная операция — connect к `unix:///Users/aleksejkozemakin/.docker/run/docker.sock`; previous attempts получали permission denied до Docker info. Escalation запрещён политикой, новых обходов/повторов нет. Loopback/portable проверки доступны. Пользовательский Terminal уже подтверждён рабочим.

Не повторять все unit/integration/native suites и полный AMD profile. Следующая команда собирает raw AMD syscall diagnosis на retained builder и независимо запускает focused production encrypted E2E. Первый diagnostic ожидаемо может завершиться ненулевым кодом; его JSON/FAIL сохраняются, это не подавляется в qualification и не становится PASS. Он не мешает отдельному ARM encrypted run:

```bash
(
  set -euo pipefail
  cd ~/Desktop/HomeCloud
  unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH HOMECLOUD_E2E_BACKEND_IMAGE
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
  probe_rc=0
  python3 -B scripts/ci/run-pr45-qualification-local.py linux/amd64 \
    --probe-existing /tmp/homecloud-pr45-qualification-amd64.1izbhl0_ 2>&1 \
    | tee /tmp/homecloud-pr45-amd64-native-probe.log || probe_rc=$?
  printf 'AMD64 diagnostic exit: %s (see qualification JSON)\n' "$probe_rc"
  docker build --platform linux/amd64 -t homecloud-restore-e2e-runner:local \
    - < scripts/ci/restore-e2e-runner.Dockerfile
  bash scripts/ci/run-restore-e2e-local.sh linux/arm64 --encrypted-only 2>&1 \
    | tee /tmp/homecloud-pr45-encrypted-e2e.log
)
```

Если retained AMD image уже удалён, diagnosis откажет на inspect; не делать вывод об openat2 по отсутствующему image. ARM encrypted backend всё равно fresh build. После исполнения читать оба fixed logs и новый report directory. Полный native AMD qualification нужен на подходящем Linux/AMD64 runtime; изменение Docker Desktop security settings ради PASS не разрешено и не предлагается.

### 28.6. Итоговый статус по17 и продолжение

**NOT READY.** B01 (durable publication/ambiguous COMMIT/storage restore): ARM PG317+native benchmark квалифицированы, copy/crash/current+historical storage roundtrips PASS; остаются обязательная подходящая AMD environment, actual historical DB schema7..15 matrix и оставшиеся host faults. B02 (единый writer fence/maintenance/permits): ARM inherited/orphan/operator13 и maintenance/copy runtime PASS; permit9 portable,42 host lifecycle contracts PASS; полный installed TEST/host recovery lifecycle ещё не квалифицирован. Ни один finding не закрыт одной загрузкой addon или unit PASS.

Реальный plain Backup→Restore и historical root identity roundtrip из24 остаются PASS на их source snapshot; backend и production recovery/security code этим checkpoint не менялись. Combined encrypted mode подготовлен, ещё не выполнен. Новый native raw syscall probe подготовлен, ещё не выполнен в AMD контейнере. Все недостающие11/14/16 gates остаются в JSON remaining; отсутствие новых confirmed source findings не заменяет их qualification.

CI: local workflow source изменён, published successful runs относятся только к старому ee84ddd6; текущие изменения не публиковались. PR45 последний проверенный open/draft, base85578280. После mandatory PASS планируются маленькие русские commits: backend durable copy/fence; host Backup/Restore/recovery; CI/qualification; handoff evidence. Сейчас новых commits нет, staged пуст; Git metadata sandbox read-only, обязательные checks ещё не завершены.

Source manifest **102 файла**, SHA256 `515ff0375dbcc2cd671d7b398065ac02063ffdb591a692450a6d05f51fa8b8d1`. Git:48 modified +59 untracked, включая2 handoff и3 исходных посторонних файла. Эти3 файла и вся прежняя работа сохранены. Единственный репозиторий/ветка/HEAD прежние. Новых веток/worktree/клонов/destructive Git/production/push/merge/deploy/release не было.

## 29. Raw openat2 отказ подтверждён; native DinD fixture (14 ноября)

### 29.1. Новые фактические результаты

В начале checkpoint manifest102 совпал102/102; ветка/HEAD прежние. Прочитаны локальные логи и report нового запуска. Последний вложенный Library text относится к предыдущему AMD full run, нового результата в нём нет; актуальные файлы `/tmp` использованы напрямую.

**AMD diagnostic — ожидаемый отказ, не qualification PASS.** `/tmp/homecloud-pr45-qualification-amd64.l9c9oou7/qualification.json`, source515ff037…: retained builder00288ffb… реально x64, addon loaded=true, nativeBoundaryOperational=false, phase=root, ENOSYS. Отдельная C-программа с target Linux headers вызвала syscall437/openat2: **minimal_errno=38, strict_errno=38**. Это исключает объяснение только HomeCloud root checks/resolve flags; syscall недоступен в данной cross-architecture execution среде. Конкретный слой emulator/seccomp/kernel по этим данным не определяется. Никакого fallback или отключения security checks нет. Full suites не повторялись.

Report SHA256 `e702ca87d09a730c75254b4520cd680497a4c6a513286bb47745a8cf100e11ec`; fixed diagnostic log `/tmp/homecloud-pr45-amd64-native-probe.log`,437 bytes, SHA256 `f0a0dc3159c7b130ba0e69cee507500175ed292a758df6b62a3d08f4082b5eed`. Suitable native Linux/AMD64/exact retained OCI qualification остаётся обязательной; повторять этот diagnostic на том же retained image не требуется.

**Encrypted E2E — FAIL до Backup.** `/tmp/homecloud-pr45-encrypted-e2e.log`,217 lines/18013 bytes, SHA256 `fa58e5b2c9146d66208b8e9f07eb775ebdb78fd7b04c0bd88df54b920efc5a7e`:

- Fresh requested ARM backend собран: confige170d1d…/manifestc1090721… совпадают с ранее успешным core run; новый manifest listd7a9aeed….
- Runtime trust/ownership/ancestry проверки PASS; private cgroupv2/domain delegation PASS.
- Загружены backend/PG/stub images. Nested daemon20.10.24 объявил linux/amd64; smoke image — ARM64. Первый container start завершился `runc create failed ... can't copy bootstrap data to pipe ... broken pipe`.
- Daemon log также содержит `seccomp is not enabled in your kernel, running container without default profile`. Эта среда не может считаться доказательством сохранённой изоляции.
- Ошибка произошла до ext4 fixture allocation, PostgreSQL/backend service startup, API seed и coordinator backup. Ни encrypted Backup, ни Restore этим запуском не квалифицированы. Отдельная host inventory cleanup после outer exit не проверялась из sandbox.

Предыдущее изменение26 правильно обнаружило неверную platform metadata, но принудительный AMD64 DinD был недостаточным решением для ARM64 host. Эмулированный daemon/runc не подходит для этого fixture. Прежние результаты не переписываются: существующий core/historical PASS относится к прежнему source/стенду, а новый encrypted run остаётся FAIL.

### 29.2. Исправление только fixture packaging/qualification

`restore-e2e-runner.Dockerfile` использует уже сохранённый в `scripts/ci/images.platforms.json` **node-ci multiarch index** `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`, вместо одиночного AMD manifest. Registry bytes независимо скачаны через public Docker Registry API и SHA256 совпал. Index содержит:

| Platform | Immutable child manifest |
|---|---|
| linux/amd64 | `sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd` |
| linux/arm64/v8 | `sha256:ba6b7d0ee561d9d49deb99e2b93c98632cc287b6cca1a6b18d66127054efa4dc` |

Debian docker.io/containerd/runc/Python ставятся для настоящего target platform. Compose остаётся **5.6.0**: AMD checksum40343e21… прежний из CI; ARM checksum `733ec76717ceb59052a9609b9dadfb523b2df8eab57a54212872d10a58078ea2` получен из официального release checksums.txt. ARM binary независимо скачан/хеширован:30538254 bytes, little-endian ELF64 e_machine183, digest совпал. Install выполняется только после проверки checksum; никаких floating Compose tags или unchecked executable downloads.

`run-restore-e2e-local.sh` теперь:

1. Требует native Docker Engine requested platform и matching PG/stub image architecture до builds/privileged containers.
2. Сам собирает актуальную fixture base под native platform, чтобы ранее собранная AMD tooling base не осталась неявным prerequisite. Backend по-прежнему строится один раз; retained OCI override по-прежнему запрещает product rebuild и проверяет exact IID после retag.
3. Выполняет actual product root/directory/flock `--strict` preflight до nested daemon.
4. Передаёт expected native platform в runtime trust preflight и в DinD entrypoint. Preflight сверяет actual Node arch и ELF64 e_machine **Node, Python, docker, dockerd, containerd, runc, Compose**, затем проверяет Compose5.6.0. Одной image metadata недостаточно.
5. До ext4/DB/API выполняет существующий CPU/memory/PIDs smoke, дополненный обязательным **Seccomp:2** в реальном nested process. Отсутствующий default filter не допускается.

CI сохраняет тот же retained product candidate; убрана только избыточная внешняя base build команда, потому что launcher владеет native base build. Non-DinD Python/HTTP/age qualification tooling сохраняет свой честный AMD64 platform и прежние результаты; это не разрешает emulated DinD.

Backend/native C, recovery/restore production helpers, deploy anchors и immutable host verifier этим checkpoint не менялись. Production pins/Compose policy/security checks не ослаблены. Новый native fixture **ещё не собран/исполнен реально** этой сессией.

### 29.3. Проверки и их пределы

- Runtime context/preflight **13 PASS**: включая отказ при одном AMD runtime binary, wrong actual Node arch, invalid ELF, wrong Compose version; trusted existing index; tampered Compose download не записывается/не устанавливается.
- Новый recording-Docker launcher suite **8 PASS**: wrong Engine, foreign nested image, wrong base, failed native operation и candidate substitution прекращают запуск; retained product не перестраивается; native base/platform/preflight порядок и отсутствие host binds/seccomp bypass проверены. Docker в этом suite fake; real nested daemon PASS не утверждается.
- Полный recovery driver:23 Python suites **301 PASS/1 SKIP**, Node permit9 и native probe4 PASS — **314 PASS/1 SKIP**. Финальный log `/tmp/homecloud-pr45-native-dind-contracts-final.log`; SHA и итог в JSON.
- Дополнительно CI gate5/policy coverage15/OCI binding9 —29 PASS. Итого выполненные test commands этого checkpoint: **28 команд,343 PASS/0 FAIL/1 SKIP**. Standalone повторения не прибавлены. Host verifier18/root boundary26 PASS из28 сохранены отдельно как44 carried-forward assertions на неизменившемся source, не прибавлены к343.
- Skip — host age dependency; actual Linux focused age34 и scheduled22 уже PASS, combined production encrypted lifecycle всё ещё pending после fixture fix.
- YAML, Bash syntax, Python3.9 AST включая inline Dockerfile installer, whitespace и normalized tar metadata — PASS. Context52 members, SHA256 `7256c0692bea2605e5c3441a21dd478f6d12d20e30ef4a766a70366439834024`.

### 29.4. Текущий блокер среды

Новая read-only попытка этой сессией выполнить `docker info` с fixed local Desktop socket снова получила **permission denied while trying to connect to the docker API at unix:///Users/aleksejkozemakin/.docker/run/docker.sock**. Exit1,0 builds/0 containers. Escalation/обход не запрашивались. Доступ к public release/OCI metadata позволил независимо проверить pins, но не заменяет Docker execution.

### 29.5. Следующий Terminal run — только focused encrypted E2E

Не повторять raw AMD diagnostic, full AMD profile, успешные ARM suites или plain/historical cycles. Launcher сам пересобирает native base/runtime/current backend. Новый log filename сохраняет предыдущий failure log:

```bash
(
  set -euo pipefail
  cd ~/Desktop/HomeCloud
  unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH HOMECLOUD_E2E_BACKEND_IMAGE
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
  bash scripts/ci/run-restore-e2e-local.sh linux/arm64 --encrypted-only 2>&1 \
    | tee /tmp/homecloud-pr45-encrypted-e2e-native.log
)
```

Перед private daemon ожидаются native product boundary PASS и native daemon/runtime/Compose ELF preflight PASS. После его старта обязательны nested Seccomp:2/CPU/memory/PID smoke и затем `PASS: REAL ENCRYPTED BACKUP -> OFFSITE -> RESTORE E2E`. Никакая ошибка preflight или coordinator не считается PASS. Следующий отказ разбирать по полному новому логу, сохраняя предыдущие evidence.

### 29.6. Checkpoint

**NOT READY.** B01/B02 не закрыты до обязательной qualification. Сохраняются actual ARM unit1149, integration427 (317 PG+native benchmark покрыли исторические318 skips), native13, copy/maintenance/crash/age/scheduled и core/historical root identity результаты на их snapshots. Combined encrypted coordinator, suitable native AMD/exact OCI CI, actual supported old DB7..15 matrix и оставшиеся TEST/host lifecycle/fault gates из11/14/16 остаются открыты.

Manifest **103 source files**, SHA256 `24cb8954dae6f99cae974300b235b0c2efee90ab5bddbe813e8a7719d7424d91`. Ветка `миниатюры-файлов-v1`, HEAD `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`, PR45/base85578280 прежние;48 modified +60 untracked, staged пуст, новых commits нет. Все прежние изменения и3 исходных посторонних файла сохранены. Нет новых branches/worktree/clones/destructive Git/production/push/merge/deploy/release. После обязательных PASS — маленькие русские commits и итоговый exact-HEAD independent review; до этого DONE/READY не объявлять.

## 30. Реальный encrypted coordinator PASS; историческая DB matrix подготовлена

### 30.1. Подтверждённый production encrypted E2E

При продолжении branch/HEAD прежние; manifest103 из29 совпал103/103. Полностью прочитан `/tmp/homecloud-pr45-encrypted-e2e-native.log`:643 lines/42822 bytes, SHA256 `852ba302d9f7095204a9d5fb67c939eca9d9598a220de8afb2d09fa800f1b850`. Source snapshot `24cb8954dae6f99cae974300b235b0c2efee90ab5bddbe813e8a7719d7424d91`, context7256c069….

**PASS: REAL ENCRYPTED BACKUP -> OFFSITE -> RESTORE E2E.** Это выполнение настоящих `backup-production.sh`/`backup-production.py` и `restore-offsite.sh`, с реальным raw Backup/Restore, PostgreSQL, production backend, startup disk gates, native fence и API. Raw children не подменялись.

| Доказательство | Фактический результат |
|---|---|
| Product boundary | actual Node linux/arm64, nativeAddonLoaded=true, nativeBoundaryOperational=true, phase=complete; root/directory/dev-ino/flock выполнены. Compiler отсутствует в production runner, optional raw C probe там не запускался |
| DinD/toolchain | Node/Python/docker/dockerd/containerd/runc/Compose ELF — ARM64; actual Node ARM64, Compose5.6.0 |
| Isolation | private cgroup domain/controller delegation; nested **Seccomp:2**,512MiB/1CPU/128PIDs фактически проверены процессом |
| Startup/data | startup disk gates PASS; legacy storage identity enrolled; все4 services healthy; register/login/quota100MiB/upload через API |
| Encrypted production backup | event backup_production_completed, generation `hc_20261113T224325Z_09cb3534e27e40f8`, offsite_verified=true |
| Offsite validation | encrypted_offsite_validation_completed, тот же generation; after-backup record сохранён validate-only |
| Actual restore | encrypted_offsite_restore_completed, тот же generation |
| Final data | exact original downloaded bytes; after-backup file отсутствует; original container IDs/storage root identity, quota и copy journal согласованы |
| Cleanup | нет inhibitor/receipt/permit/stage/swap; success markers соответствуют generation; plaintext directories/production lock удалены |

Backend payload manifest `sha256:c10907214fd2a96830f5fa86b310783708dd80755c70cc581fd163009752dbfc`, config `sha256:e170d1d252b38b907f361e0905d6e23df20f955d7c63845d94977446ad0eb78d` совпали с прежним core run. Новый backend list `sha256:b7aad2fc682581e02b23805d51c1e89306aca58de175ba8cbe7180ac3bb8acad`; native tooling list0d405a65…, runtime liste78a4b4f…. Полные IDs записаны в JSON.

Ограничения: offsite — отдельный private directory в disposable runtime, не физически удалённый носитель; frontend/ingress stubs; один ext4. Global host/container/volume inventory после outer cleanup независимо не проверен. Точная server_version в этом логе отдельно не напечатана; ранее тот же профиль PG квалифицирован как16.15, а новый fixture теперь явно требует `SHOW server_version=16.15`. Этот PASS не закрывает native AMD, installed TEST и остальные fault/migration gates.

### 30.2. Следующий обязательный этап подготовлен без изменения production gate

Добавлен `--historical-schema-only`. Он проверяет **ровно поддерживаемые текущим Restore контрактом состояния7/8/9/10/11/13/15 таблиц**. Shorthand «7..15» не означает, что12/14 поддерживаются; их новый отказ не вводился. Поддержка произвольной промежуточной schema не объявляется.

Для каждого состояния:

1. В отдельном PostgreSQL16.15 с network=none, read-only root, bounded memory/CPU/PIDs и private tmpfs создаётся настоящий исторический migration prefix из неизменённых compiled migrations текущего production image.
2. Source producer подключается только к loopback этого отдельного PG namespace; его raw fixture DataSource не адресует application/target DB. Это реконструкция historical input, а не обход production datasource при Restore. Entities/synchronize disabled; миграции выполняются transaction=all. Сначала исходные6 migrations и один пользователь/файл с реальными bytes/bcrypt/quota; затем полный выбранный prefix. Сверяются реальные table count и migrations timestamps/count. Sequence state установлен для последующих API uploads.
3. Dump снимается настоящим pg_dump. Создаётся согласованный storage archive с единственным original payload и каноническим старым root `.homecloud-storage-identity`; raw metadata/sidecar SHA пересчитываются. Template — один свежий настоящий fenced Backup, его bytes остаются неизменными.
4. Source PG удаляется до target Restore. Container cleanup failure фатален; никакие посторонние IDs/volumes не удаляются. Неожиданные image VOLUME declarations запрещены. Новые files находятся только в own `/tmp/homecloud-e2e.*` внутри disposable outer container.
5. Target изменяется через API; **unchanged production** Restore --validate-only проигрывает SQL и migrations в изолированном валидаторе, после чего after-backup record должен остаться. Restore --yes выполняет actual gated migration до17 таблиц, fencing/reconciliation/restart. Exact API download/quota/journal/container/root identity и cleanup проверяются после каждого случая.

| Historical tables | Последний включённый timestamp | Реальных migrations |
|---|---|---|
|7|1746825120000|18|
|8|1746825130000|19|
|9|1746825140000|20|
|10|1746825150000|21|
|11|1746825170000|23|
|13|1746825210000|27|
|15|1792831200000|30|

Ожидается7 полных Restore cycles. Это **PENDING EXECUTION**, не PASS; actual retained old release binaries/dumps и все возможные historical user datasets этим генератором не воспроизводятся. Existing published migration source не менялся. Новый fixture producer не используется production scripts/installed host.

Файлы: `historical-schema-producer.cjs`, `test-historical-schema-e2e.py`, их Node/Python regressions; context/trust inventories расширены на2 root-owned fixture assets. В E2E function проверки перемещена перед mode branches без изменения её тела. Stub PID1 теперь обрабатывает TERM через background wait, сокращая лишние60-second stops; production frontend/ingress не менялись. CI добавляет этот mode на **тот же retained candidate** с сохранённым exact IID binding и без второго product build. Hosted execution новых steps ещё не подтверждено.

### 30.3. Доступные проверки

- Producer prefix tests **5 PASS**: все реальные source prefixes, missing/duplicate migration, неизвестные counts и настоящий Node stdin entrypoint. Обнаружена и исправлена особенность stdin `require.main`: producer теперь действительно входит в main при `node -`, с regression до любого DB access.
- Python fixture tests **5 PASS**: gzip/tar/sidecar checksums, canonical old marker, immutable baseline, wrong-marker refusal, host Docker refusal, exact owned source CID cleanup при failure и отсутствие DB credentials в error text.
- Launcher **9 PASS**, runtime context/preflight13 PASS. Всё recording/mocked scope, не реальный PG matrix.
- Полный portable driver:24 Python suites **307 PASS/1 SKIP**, Node permit9/native4/prefix5 =18 PASS. Driver **325 PASS/1 SKIP**; `/tmp/homecloud-pr45-historical-schema-contracts-final.log`, SHA256 `f77a03690084a3116cd2567b93888574ad8552b4d397b032fa00860adc80ce79`.
- CI gate5/policy15/OCI binding9 —29 PASS. **Итого30 test commands:354 PASS/0 FAIL/1 SKIP**, без повторного прибавления standalone runs и без смешивания с отдельным real encrypted E2E PASS. Host verifier18/root boundary26 из28 carried forward по неизменённым исходникам.
- Python3.9 AST, YAML, Bash/Node syntax, whitespace, tar UID/GID0:0/no group-other write — PASS. Новый context54 members, SHA256 `6b4af086b10c2bf1cc328e3d898c5f4c430d5fd4fbbf5307d3e239e4be3bce4a`.

### 30.4. Единственный необходимый следующий Terminal run

Повторный read-only `docker info` в этой сессии снова получил permission denied на fixed local Docker Desktop socket, exit1 до любых builds/containers. Escalation/обходов нет. Не повторять успешный encrypted run, предыдущий core или неподдерживаемый AMD diagnostic.

```bash
(
  set -euo pipefail
  cd ~/Desktop/HomeCloud
  unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH HOMECLOUD_E2E_BACKEND_IMAGE
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
  bash scripts/ci/run-restore-e2e-local.sh linux/arm64 --historical-schema-only 2>&1 \
    | tee /tmp/homecloud-pr45-historical-schema-e2e.log
)
```

Это7 последовательных actual migrations/restore cycles; при первом отказе set-e останавливает профиль, evidence сохраняется, ни один последующий случай не объявляется PASS. Обязательная финальная строка — `PASS: HISTORICAL DATABASE SCHEMA MATRIX 7/8/9/10/11/13/15`. После неё автономно переходить к оставшимся TEST/host lifecycle/fault gates, не повторять уже квалифицированные source-unchanged suites.

### 30.5. Checkpoint

**NOT READY.** Combined encrypted lifecycle теперь PASS и снят из remaining. Native AMD/exact OCI CI, real supported historical DB matrix, remaining TEST/host install/recovery/fault scenarios и final commits/review остаются открыты. B01/B02 не закрываются одним новым PASS. Production recovery/restore/security guards и backend не менялись; все прежние результаты и evidence сохранены.

Manifest **107 source files**, SHA256 `0352029267622a78545980470e400945e4f314446360808c6f765d9ed3fde179`. Ветка `миниатюры-файлов-v1`, HEAD `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`, PR45/base85578280 прежние;48 modified +64 untracked, staged пуст, новых commits нет.3 исходных посторонних файла сохранены. Нет новых branches/worktree/clones/destructive Git/production/push/merge/deploy/release.

## 31. Historical DB matrix PASS7/7; подготовка real Docker fault matrix

При продолжении107/107 source hashes совпали; branch/HEAD прежние. Полностью прочитан `/tmp/homecloud-pr45-historical-schema-e2e.log`:2552 lines/98879 bytes, SHA256 `4da0e3cb14d7dea62f860ef99fd1258c09ec40b8d4af220cd9ab6dea352e98c2`, source03520292…/context6b4af086….

**PASS: HISTORICAL DATABASE SCHEMA MATRIX 7/8/9/10/11/13/15.** Все7 actual prefix fixtures созданы реальными migrations/PostgreSQL16.15; counts18/19/20/21/23/27/30 подтверждены. Все7 прошли production --validate-only, actual Restore до17 таблиц и API exact-byte/quota/journal/root/container identity/maintenance cleanup.7 RESTORE_COMPLETE,7 RECONCILE_STATUS:OK с нулевыми6 counters,7 final data/cleanup PASS. В каждом архиве был канонический historical root identity marker, а template backup не менялся. Ограничения reconstructed prefixes/один synthetic dataset/не retained old binaries из30 остаются.

Backend confige170d1d… неизменён, list07c55ced…; tooling listc5bb2900…; runtime list2cb0a860…. Exact IDs/events/hashes — в JSON. Production schema/security source не изменён этим checkpoint.

Следующий этап в работе: реальный Restore fault matrix, а не повтор удачных cycles. План7 изолированных случаев: partial stop failure, SIGKILL после STORAGE_STAGED/DB_RESTORED/RECONCILED/READY-before-clear/READY-after-clear, foreign writable container. Каждый — отдельный disposable outer environment. Instrumentation только в root-owned runtime fixture; underlying production helper bytes и guards сохраняются, никаких production fault env hooks или host verifier waiver. Проверить durable evidence, правильное DB/storage состояние по phase, stopped writers, блокировку новой operation и обычного backend startup; clear-before-restart отдельно re-fence через actual retain. Это пока IN PROGRESS, не PASS.

### 31.1. Подготовленная fault matrix и точный scope

`run-restore-fault-e2e-local.sh` последовательно запускает7 новых outer containers/ext4/PG/API environments. В каждом fresh real fenced Backup, затем API добавляет after-backup file; успешные encrypted/historical restore profiles не повторяются. `--fault-case=…` — только вход CI fixture, production scripts/env contract новых fault hooks не получили.

Внутри disposable runtime `test-restore-fault-e2e.py` сохраняет исходные bytes `restore_maintenance.py` и исполняет их из root-owned wrapper по **тому же canonical __file__**, с оригинальными ROOT/trust/functions/guards. Callback либо прерывает после настоящего stop двух сервисов, либо атомарно публикует barrier после настоящего durable write/clear, делает SIGSTOP; controller проверяет owned process group и **Linux /proc State:T**, затем SIGKILL всей Restore session. Original helper SHA печатается; исходные bytes восстанавливаются в finally. Git working tree production helper не изменяется. Source helper и injection metadata scope не скрыты в evidence.

| Case | Ожидаемый checkpoint/данные после отказа |
|---|---|
| partial-stop | actual ingress/frontend stop, injected acknowledgement failure; настоящий Bash EXIT cleanup. INHIBITED, DB2/physical2 без destructive changes |
| staged | SIGKILL после durable STORAGE_STAGED; DB2/physical2 unchanged, verified staged backup сохраняется |
| db-restored | SIGKILL после DB_RESTORED; DB1/old physical2 и проверенный stage1. Это намеренно незавершённое fenced состояние, не обещание rollback |
| reconciled | SIGKILL после RECONCILED до swap deletion; DB1/new physical1; verified old swap2 сохранён с прежними bytes/inode |
| ready-before-clear | SIGKILL после READY до marker clear; DB1/physical1, swap удалён после data checks; marker и receipt сохранены |
| ready-after-clear | SIGKILL после actual marker clear; READY receipt блокирует новую operation; actual original retain создаёт новый inhibitor/RESTART_FAILED |
| foreign-writer | отдельный unlabeled running container с RW bind fixture storage, даже при read-only container root; actual shared inventory обязан отказать до SQL, DB2/physical2 unchanged |

Проверяются actual receipt/token/marker identity, root/storage marker dev/ino, quota и copy journal внутри БД, точные file rows/hashes, возможность снова взять kernel locks после уничтожения Restore group. Новая operation должна отказать именно на retained maintenance, а обычный backend startup под inhibitor — действительно запустить новый PID attempt (StartedAt изменился), затем завершиться nonzero без DB/storage изменений. Ошибка самого Docker CLI вместо запуска не считается доказательством startup fencing. Container IDs сохраняются.

Foreign case вызывает **ту же production inventory function**, которой пользуется offline TEST CLI, с реальными Docker mounts. С активным actor должен быть конкретный отказ writable storage mount; удаляется только созданный actor CID, затем тот же вызов обязан пройти. TEST-only CLI/project/checkout admission не подменяются; installed TEST lifecycle этим не объявляется пройденным.

Fault mode не демонстрирует powercut/disk persistence, автоматический rollback или полное manual resume каждого retained Restore phase. После SIGKILL сохраняются operator evidence/fencing; clear-window дополнительно проверяет explicit retain. Остальные случаи завершаются уничтожением собственного disposable environment после проверок.

CI вызывает batch на том же retained OCI candidate, сохраняя exact IID/no-rebuild contract. Normal/encrypted/historical modes instrumentation не включают. Новый root-owned fixture asset включён в context/trust preflight inventories; source context55 members, SHA в JSON. Hosted execution ещё отсутствует.

### 31.2. Source review и доступные regressions

- Fault driver8 PASS: durable callback order, unrelated phases не останавливаются, actual two-service callback до injected exception, clear callback до stop, propagation foreign refusal, host/unknown-case rejection, настоящий new StartedAt для negative startup.
- Launcher10 PASS: validated fault flag и отказ unknown case до Docker, existing native/retained binding contracts. Runtime context/preflight13 PASS.
- Full portable driver:25 Python suites **316 PASS/1 SKIP**, Node permit9/native4/prefix5 =18 PASS; driver334 PASS/1 SKIP. CI gate5/policy15/OCI binding9 —29 PASS. Итого **31 команда,363 PASS/0 FAIL/1 SKIP**; standalone повторения исключены. Log `/tmp/homecloud-pr45-real-fault-contracts-final.log`, SHA256 `db54159d61d6f580352286ce099f52feaf7750968affc0e9f17828f4ff45e0d5`.
- Отдельный локальный probe на собственных process group: noninteractive Bash действительно ждёт SIGSTOP child, owned group SIGKILL возвращает -9. Это Darwin process probe, не Linux Docker fault PASS.
- AST Python3.9 (включая все7 generated wrappers), Bash/YAML syntax, normalized context ownership и whitespace PASS. Реальный fault batch **PENDING EXECUTION**.
- Повторно прочитаны11.10 inventories: installer LOCKED_FILES содержит maintenance-inhibit/window/storage-writer-fence/recover-copy; contract.FILES и pinned host-verifier helpers не менялись, deploy-tree immutability сохранена. Нормальный TEST admission текущих изменённых deploy files не разрешался. Full installed TEST/bootstrap/recovery scope всё ещё требует отдельной qualification, без обновления pins ради обхода.

### 31.3. Следующая операция в обычном Terminal

Read-only Docker info этой сессии снова DENIED на `unix:///Users/aleksejkozemakin/.docker/run/docker.sock`,0 builds/containers; escalation/обход не предпринимались. Команда выполняет только7 новых fault cases и останавливается при первом неподтверждённом сценарии:

```bash
(
  set -euo pipefail
  cd ~/Desktop/HomeCloud
  unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH HOMECLOUD_E2E_BACKEND_IMAGE
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
  bash scripts/ci/run-restore-fault-e2e-local.sh linux/arm64 2>&1 \
    | tee /tmp/homecloud-pr45-restore-fault-e2e.log
)
```

Нужны7 `real_restore_fault_verified` events,7 `PASS: REAL RESTORE FAULT CASE …` и финальный `PASS: REAL RESTORE FAULT MATRIX 7/7`. Не принимать один barrier/event или первые успешные cases за весь PASS. При отказе читать полный log, исправлять причину; при необходимости повторять только конкретный case через `run-restore-e2e-local.sh linux/arm64 --fault-case=NAME`, сохраняя прошлые evidence.

### 31.4. Checkpoint

**NOT READY.** Historical schema matrix теперь закрыта реальным7/7 PASS, encrypted lifecycle PASS сохранён. Открыты real fault batch, suitable native AMD/exact retained OCI qualification, full installed TEST/host recovery и итоговая сверка11/14/16. CI новых source не запускался remotely; публикации не было. Новых confirmed source HIGH/BLOCKER этим fixture stage не установлено; это не закрывает B01/B02 до обязательной qualification.

Manifest **110 source files**, SHA256 `52258d5abbc2bf9358059edc00024ae40795bd986a9234e567e403c188448740`. Ветка `миниатюры-файлов-v1`, HEAD `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`, PR45/base85578280 прежние.48 modified +67 untracked, staged пуст, новых commits нет. Вся предыдущая работа и3 посторонних файла сохранены. Нет новых branches/worktree/clones/destructive Git/production/push/merge/deploy/release.


## 32. Real Restore fault matrix7/7 PASS; финальная сверка TEST/CI

### 32.1. Проверенный реальный batch

Прочитан весь `/tmp/homecloud-pr45-restore-fault-e2e.log`:192596 bytes,4407 lines; SHA256 `6f80b4270b896150682b8d92a6648056a3138aac8d8594360e390804f36ee90d`. Финальная строка `PASS: REAL RESTORE FAULT MATRIX 7/7`; семь структурированных `real_restore_fault_verified` проверены по ожидаемым phase, exit, DB/storage count, retained phase, original-helper SHA и всем трём boolean assertions.

| Случай | Фаза при сбое → retained | Restore exit | DB/storage files | Результат |
|---|---|---:|---:|---|
| partial-stop | INHIBITED → INHIBITED |1|2/2|PASS|
| staged | STORAGE_STAGED → STORAGE_STAGED |-9|2/2|PASS|
| db-restored | DB_RESTORED → DB_RESTORED |-9|1/2|PASS|
| reconciled | RECONCILED → RECONCILED |-9|1/1|PASS|
| ready-before-clear | READY → READY |-9|1/1|PASS|
| ready-after-clear | READY → RESTART_FAILED |-9|1/1|PASS|
| foreign-writer | INHIBITED → INHIBITED |1|2/2|PASS|

Во всех семи случаях реальные PostgreSQL/storage соответствуют ожидаемой retained фазе; DB quota/journal internally consistent. Повторное operation admission и реальный ordinary backend startup отказали; `StartedAt` изменился перед nonzero exit, исходные container IDs и данные сохранены. После DB_RESTORED до storage switch DB/storage намеренно относятся к разным поколениям: это безопасно удерживаемая maintenance фаза, **не заявление о завершённом Restore или доступности API**.

Qualified source110 `52258d5abbc2bf9358059edc00024ae40795bd986a9234e567e403c188448740`, context55 `428013fdb12b28a099e12e8567e89de653d4960230dc9361c237820b65fd2fa0`. Все110 source hashes повторно совпали с manifest. Оригинальный `scripts/restore_maintenance.py` SHA256 `eec0937a357884a7a927997f567274a0b11d563692fe431ab89d938de702aff9` совпадает со всеми семью событиями.

Scope: actual process SIGKILL после durable checkpoint/clear и injected partial stop acknowledgement, actual production helper bodies, root fences, DB, Docker lifecycle и independent foreign-container inventory. Только runtime fixture instrumented, host helper unchanged. Не hardware powercut, не полный operator resume каждой retained фазы, не installed TEST bootstrap. Ограничения31.1 сохраняются; этот PASS не обходит TEST-only project/checkout admission.

### 32.2. Продолжение

NOT READY: native AMD64 raw openat2 ранее дал ENOSYS независимо от приложения; на той же MacBook cross-architecture среде не повторять полный AMD batch. Текущий unpublished source ещё не квалифицирован native CI/exact OCI. Existing TEST должен отказать changed deploy/operational files; host-verifier pins и installed anchors не переписывать ради допуска. Проверка оставшихся TEST contracts и итоговая evidence matrix продолжается.

### 32.3. Исправлен CI routing gap

Фактический граф: `ci.yml` имеет только `workflow_call`; прежние callers `d5-1-qualification-only.yml` и `release.yml` требуют current protected main. Обычный push в PR не запускал добавленные retained-image Backup/Restore/native/crash qualifications. Одной записи новых шагов в reusable workflow было недостаточно.

Добавлен `.github/workflows/recovery-qualification.yml`: `pull_request` opened/synchronize/reopened/ready_for_review без path/draft exclusions; permissions `contents: read`, exact `github.event.pull_request.head.sha`, existing `pull-request` profile, `candidate_version: dry-run`. Единственный job вызывает тот же `ci.yml`; нет registry push, secrets inheritance, deploy/release jobs или изменения main-only release contract. Existing PR policy для base scans сохранена; это не RELEASE qualification.

Новый `scripts/ci/test-recovery-workflow.cjs` разбирает actual YAML через уже установленный backend js-yaml: проверяет trigger/no filters, exact source/readonly/no bypass, native AMD64 OCI build без push, четыре retained-candidate E2E invocation и зависимости policy/aggregate gate. **3/3 PASS**, включён в `pr-fast-backend` обоих workflows; новый dependency/pin не добавлен. CI gate5, policy15, OCI binding9, Fast gate3, candidate4, environment evidence28 также PASS. Runtime steps используют retained product, не второй rebuild.

Caller **не опубликован и не исполнен**. Branch protection для нового check не проверена и не менялась; server-side required status не заявляется. Успеха GitHub для текущего dirty source нет.

### 32.4. TEST audit и неизменённые ограничения

- `python3 -B scripts/ci/test-test-channel.py`:43/43 PASS, включая actual synthetic Git objects/policy и maintenance contracts; Docker/install lifecycle fixture controlled.
- `python3 -B scripts/ci/test-update-preflight.py`:5/5 PASS.
- Все6 verifier SHA256 совпали с actual source и HEAD. `update-host-verify.py`, `root-boundary.py`, `update-install-bridge.py`, `scripts/ci/test-channel.py`, D5.1 и release workflows побайтно unchanged. `PROVISIONED=False` сохранён.
- Full installed TEST требует `/home/hs/homecloud-test`, root-owned anchors/checkout/runtime, exact image/source/migrations/state checkpoint, real frontend/ingress/HTTPS и actual `project-test.sh preflight`. Последний требует native rootful non-Desktop Linux/AMD64, RAM floor и два разных block-device ancestry/UUID/serial/WWN. ARM Docker Desktop/single loop ext4 и обычный hosted runner directory этот контракт не доказывают.
- `baseline-inspect` выдаёт read-only proposal; initial state adoption требует отдельного решения. Normal TEST update должен отвергнуть изменённый deploy/operational contract. Installer также требует прежний migration inventory; new-migration apply этим E2E не объявляется поддержанным.
- `docs/update-install-e2e-stand-plan.md` прочитан и сверен с actual preflight. Host, disk identities, physical-vs-virtual acceptance и initial checkpoint не предоставлены. Нового стенда, anchors или Git-копии не создано.

## 33. Итог checkpoint по формату§17 — NOT READY

### 33.1. Вердикт и идентичность

**NOT READY. B01/B02 остаются открытыми.** Перечисленные ARM64 сценарии квалифицированы; mandatory native AMD64/retained OCI и full installed TEST ещё нет. Это checkpoint для продолжения, не объявление выполненной всей задачи.

Ветка `миниатюры-файлов-v1`; HEAD `ee84ddd6cb054725f06b396e6cb10ba5fe67d622`; PR45 → test, base `85578280b40d485c2765e961e6ec4f591d43f02c`. Read-only remote recheck14 ноября: open/draft, тот же HEAD/base,43 published changed files/26 existing commits. Текущие исправления пока вне опубликованного diff.

Manifest112: `d94a3821d2a1850fd74d1db46629ed808a8ef321a7433bdd11cfea4f06153e23`. После source110 real fault PASS изменены только два существующих workflow и добавлены PR caller + routing test. Backend/production recovery/deploy source не менялись; прежние results перенесены с exact snapshots, без выдуманного повторного исполнения.

### 33.2. Реализованные исправления и findings

Сохранены descriptor-based copy/admission journal/ambiguous COMMIT reconciliation; inherited/orphan root fence/supervisor; durable maintenance/shared operation lock; stage-before-SQL Restore, identity-bound permit/retained checkpoints; verified backup completion; bounded exact-container restart; безопасная совместимость historical root identity. Исправлены реальные fixture packaging, architecture, cgroup, encrypted/historical harness ошибки. Последний fix — reachable PR qualification route32.3. Production trust boundary не ослаблялась.

| Finding | Основные исправления/файлы | Доказательства | Открыто |
|---|---|---|---|
| B01: publication/DB-storage/ambiguous COMMIT | files.service/admission/offline-recovery, migration1792831300000; restore.sh/restore_storage/restore_maintenance/recovery_storage/reconcile | PG317+native benchmark закрыли прежние318 skips; integration427; actual COMMIT/ACK faults и reserved/claimed/unlinked SIGKILL; CLI5/guards8/validator7; real plain/encrypted/historical/fault restores | Native AMD64/exact OCI, installed TEST/operational recovery; не полный operator resume/powercut proof |
| B02: writers/maintenance/startup/permits | copy-root-fence-supervisor/inherited-root-fence/startup/datasource; deploy maintenance/window/writer-fence/recover-copy; Compose bind; marker dev/ino BigInt permit | Native13; Linux crash2; supervisor5; permit9; real shared foreign RW rejection; inhibited actual startup во всех7 fault cases; installer43/restart7 | Installed TEST bootstrap/root wrapper/full lifecycle; старый verifier обязан отвергать operational change |

### 33.3. Команды и результаты

Counts разных прогонов не складываются в якобы уникальный общий набор. PG317 — subset integration427, targeted205 — subset unit1149. Все exact commands, raw report/log paths, hashes и source snapshots сохранены в JSON; прежние FAIL не переписаны.

| Проверка / команда | Фактический результат |
|---|---|
| `python3 -B scripts/ci/run-pr45-qualification-local.py linux/arm64`, reportzcpwadth и corrected raw gate | Unit80 suites1149 PASS; integration33 suites427 PASS,0 skips; PG16.15 |
| Native inherited/orphan/operator из того же профиля |13 PASS |
| Real Linux ownership/flock/parent+writer SIGKILL |2 PASS |
| `bash scripts/ci/test-maintenance-supervisor.sh IMAGE linux/arm64` |5/5 PASS на exact production runner |
| `bash scripts/ci/test-copy-recovery-e2e.sh IMAGE linux/arm64` |CLI5/5, SQL guards8/8, actual validator7/7 PASS |
| Focused real age suite полного ARM профиля |34 PASS; production coordinator отдельно ниже |
| `python3 -B scripts/ci/run-pr45-qualification-local.py linux/arm64 --scheduled-only` |22 PASS/0 FAIL/0 SKIP, reportnpunl3m4 |
| `bash scripts/ci/run-restore-e2e-local.sh linux/arm64` |Real plain Backup→Restore + historical root identity PASS |
| Та же команда `--encrypted-only` |Production Backup→Offsite→Restore PASS, exact bytes/quota/journal/IDs/cleanup |
| Та же команда `--historical-schema-only` |Supported7/8/9/10/11/13/15:7/7 PASS, real migration prefix/pg_dump/current migration/API |
| `bash scripts/ci/run-restore-fault-e2e-local.sh linux/arm64` |7/7 PASS: partial stop, пять SIGKILL, foreign RW actor; table32.1 |
| `bash scripts/ci/test-recovery-contracts.sh` + CI gate/policy/OCI binding, checkpoint31 |363 PASS/0 FAIL/1 host age skip,31 commands; age отдельно real34 + scheduled22 + encrypted production PASS |
| Frontend npm test/build/lint, unchanged frontend |78 suites434 PASS; build/lint PASS |
| Backend build/lint, unchanged backend |PASS,20 existing lint warnings |
| Compose4 profiles, Python3.9/Bash/Node syntax |PASS на сохранённых snapshots; current YAML9/9 parse PASS |
| Current9 targeted commands ниже |115 PASS/0 FAIL/0 SKIP; часть повторяет прежние policy checks |
| `git diff --check`, manifest path/SHA, staged diff |PASS;112 exact entries, staged empty |
| Full AMD64 Docker Desktop profile |**FAIL**: integration272 PASS/155 FAIL; native4 PASS/9 FAIL; unit без complete raw JSON; maintenance/copy FAIL |
| Independent retained AMD64 syscall probe |Actual SYS_openat2=437: minimal/strict errno38 ENOSYS; не application-only отказ. Возвращающая ENOSYS прослойка не установлена |

Current commands, все exit0:

```text
python3 -B scripts/ci/test-test-channel.py                 43 PASS
python3 -B scripts/ci/test-update-preflight.py              5 PASS
node --test scripts/ci/test-recovery-workflow.cjs           3 PASS
python3 -B scripts/ci/test-ci-gate.py                       5 PASS
python3 -B scripts/ci/test-policy-coverage.py              15 PASS
python3 -B scripts/ci/test-oci-scan-binding.py              9 PASS
python3 -B scripts/ci/test-ci-v2-fast-gate.py                3 PASS
python3 -B scripts/ci/test-ci-v2-candidate.py                4 PASS
python3 -B scripts/ci/test-environment-evidence.py         28 PASS
```

### 33.4. E2E/fault evidence и ограничения

Log SHA256: plain `66f0ca2909061b565015cebb9dbdcbc40f3132309dcfcf4638c90670a18d31e4`; encrypted `852ba302d9f7095204a9d5fb67c939eca9d9598a220de8afb2d09fa800f1b850`; historical `4da0e3cb14d7dea62f860ef99fd1258c09ec40b8d4af220cd9ab6dea352e98c2`; fault `6f80b4270b896150682b8d92a6648056a3138aac8d8594360e390804f36ee90d`. JSON содержит absolute paths, размеры, events, exact source/context/image digests. Product payload manifest `sha256:c10907214fd2a96830f5fa86b310783708dd80755c70cc581fd163009752dbfc`, config `sha256:e170d1d252b38b907f361e0905d6e23df20f955d7c63845d94977446ad0eb78d` сохранены.

§14D: actual COMMIT outcome/SIGKILL writer/root/orphan, staging-before-SQL, DB_RESTORED, RECONCILED, READY before/after clear, partial stop и foreign writer квалифицированы в своих пределах. Mid-migration/reconciliation/cleanup errors, SQL/preflight errors, malformed staging и stale permit/receipt дополнительно проверены portable contracts; не выданы за реальные аппаратные аварии внутри каждой операции. Retained фазы блокируют admission; полный operator resume каждой фазы не продемонстрирован. Lost ACK инжектируется вокруг настоящего PG transaction, не сетевым TCP fault proxy.

Core E2E: frontend/ingress stubs, local private offsite directory, один loop ext4 для DB/storage. Historical fixtures — actual supported migration prefixes, не retained старые binaries/произвольные datasets. Нет physical disk outage/powercut qualification. Privileged DinD не абсолютная sandbox, но без host socket/source binds/secrets/user volumes. Это не full installed TEST/real frontend/HTTPS/two-disk acceptance.

### 33.5. Сверка§§11/14/16

| Раздел | Итог |
|---|---|
|11.1 staging доSQL;11.2 partial admission;11.3 проверки доswap deletion |ARM real + portable PASS, durable evidence retained |
|11.4 READY/restart |Actual fail-closed PASS; full operator resume не квалифицирован |
|11.5 migration permit |Marker/token/command negatives + actual migrations positive PASS |
|11.6 offline recovery |Actual CLI/shared inventory PASS; installed TEST wrapper pending |
|11.7 RELEASE backup |Plain/combined encrypted actual PASS |
|11.8 physical identity |Startup/enrollment/target identity actual PASS на loop ext4; two-disk contract pending |
|11.9 restart |Bounded exact-container contracts + actual lifecycle PASS |
|11.10 trust/CI |Pins/immutable policy/source tests PASS; PR routing fixed locally; actual native CI/installed TEST pending |
|14A/B |Restart исправлен; real plain/historical/encrypted Backup→Restore PASS |
|14C/D |Source hardening и перечисленные faults квалифицированы; operational/native gaps оставлены |
|14E /16 overall |Полные ARM suites/frontend PASS; native AMD/new CI/full TEST/final commits/exact-HEAD independent review **не завершены** |

§16 не закрыт. Новых неустранённых source findings этим этапом не установлено; это не independent security PASS и не закрывает B01/B02. Ограничения перечислены; manifest/dirty tree сохранены.

### 33.6. Файлы, коммиты и Git

48 tracked modified +69 untracked =117 paths.112 source files перечислены с SHA/state в JSON;2 handoff docs и3 исходных посторонних файла учитываются отдельно. Source groups: backend38; deployment/Compose13; recovery8; regressions30; runtime fixtures19; CI4. Посторонние3 файла не изменялись и в proposed commit groups не включены. Staged пуст, HEAD/ветка прежние.

**Новых коммитов нет:** по условию пользователя финальные commits идут после mandatory qualification, она ещё не завершена; Git metadata также read-only для агента. JSON содержит6 reviewable file groups с русскими proposed messages — план, не Git mutation. Handoff evidence предполагается отдельным docs commit после фиксации qualified source HEAD. Для native CI нужен отдельно согласованный порядок checkpoint commits/publication: непубликованные dirty bytes Actions не исполняет.

### 33.7. CI/PR и следующие обязательные операции

Read-only GitHub recheck14 ноября: runs42828127020,42828126813,42828126997 success относятся только ee84ddd6. Source112 и новый caller remote не исполнялись. Branch protection нового check не проверена/не менялась.

1. **Native AMD64/exact OCI:** новый PR caller подготовлен. Нужны checkpoint commits в существующей ветке и отдельно согласованный push, чтобы Actions исполнил текущие bytes до merge. Не выполнено. Main-only D5.1/release gate не обойдён. Повтор AMD Desktop profile/probe не нужен: raw syscall ENOSYS уже доказан.
2. **Full installed TEST:** нужен isolated native Linux/AMD64 stand с двумя disk identities/UUID/serial/WWN и достаточной RAM; reviewed initial checkpoint/bootstrap; unchanged helper/migration transition; actual backup/image switch/API/real frontend/HTTPS/failure+recovery evidence. Existing stand plan требует двух eligible protected TEST commits/image pairs с неизменёнными operational helpers/migrations. Текущий изменённый PR нельзя подставить вместо такого artifact или протащить через старый verifier. Одного нового host недостаточно: initial/target evidence и безопасный qualification/bootstrap contract тоже должны быть определены. Выделенный host и physical-vs-virtual acceptance не предоставлены. Production не использовать.
3. **Final closure:** после gates — логические Russian commits, final source HEAD evidence и independent security review. Никакая последующая публикация/merge/deploy/release не авторизована этим checkpoint.

**Повторная MacBook команда не требуется:** ARM batches PASS; неподдерживаемый AMD syscall исследован; Docker Desktop не удовлетворяет installed TEST non-Desktop/two-disk contract. Ещё один такой прогон не снимет блокер. Следующее действие требует native CI/publication route или выделенного стенда.

Sandbox агента не даёт API local Docker socket `unix:///Users/aleksejkozemakin/.docker/run/docker.sock`; прежнее automatic approval rejection сохраняется, обход/повторная escalation не выполнялись. Actual successful logs получены обычным Terminal пользователя и проверены локально. **Ни push/merge/deploy/release, ни production access, ни новые ветки/worktree/клоны не выполнялись.**

## 34. Разрешённая checkpoint-публикация и обязательный CI gate

Пользователь14 ноября прямо разрешил local fixes/tests, checkpoint-коммиты и обычные push в текущую ветку PR45 для native AMD64/OCI qualification, включая последующие исправления actual CI failures. Разрешение сохраняется: повторно не спрашивать его для этих действий. PR должен остаться DRAFT; merge/deploy/release/force-push/новые рабочие репозитории запрещены. B01/B02 OPEN до qualification и независимого review.

### 34.1. Фактические проверки до Git mutation

Ветка/HEAD прежние;112/112 исходных source paths/SHA совпали с `d94a3821d2a1850fd74d1db46629ed808a8ef321a7433bdd11cfea4f06153e23`. Полный tracked/untracked source diff прочитан и сохранён `/tmp/homecloud-pr45-before-publication.diff`,733823 bytes, SHA256 `82ed0e6710990e0b98c5ddc888c39b40c05d321e13a3795602c4ea5ee1dd7312` после текущих CI fixes. Проверены regular/nlink1, Python3.9 AST/Bash syntax; high-confidence private-key/GitHub-token/AWS-key patterns не найдены. Это ограниченная предварительная проверка, не замена обязательному Gitleaks CI.

Actual `git ls-remote`: origin/test=`85578280b40d485c2765e961e6ec4f591d43f02c`, origin/миниатюры-файлов-v1=`ee84ddd6cb054725f06b396e6cb10ba5fe67d622`. Push URL соответствует нужному GitHub repo. PR API подтвердил open/DRAFT и те же head/base. Git hooks — только samples, custom hooksPath не установлен. Чужие3 untracked SHA закреплены в publication evidence и не входят в commits.

Обычный `git fetch --no-tags origin test миниатюры-файлов-v1` отказал на `.git/FETCH_HEAD`: Operation not permitted. Конкретная штатная escalation этой уже разрешённой операции тоже отвергнута automatic approval policy: granular `sandbox_approval=false`. Поэтому Git metadata нельзя менять этим агентом; GitHub API для создания/перемещения commits вместо normal push не используется. Terminal helper повторяет настоящий fetch и remote conflict guards непосредственно перед commits/push.

### 34.2. Branch protection и исправленная обязательность

Read-only GitHub API protection/test: required contexts `ci-v2-fast-terminal`, `qualify`; strict=true, enforce_admins=true, allow_force_pushes=false. Настройки не менялись. `qualify` — существующий frontend workflow, поэтому новый отдельный recovery workflow сам по себе не был бы required.

Исправлен граф: обычный PR → `ci-v2-fast.yml/recovery-qualification` → `recovery-qualification.yml` reusable wrapper → `ci.yml` → existing required `ci-v2-fast-terminal`. Terminal имеет `if: always()`, зависит от recovery job и для PR отвергает skipped/failure/cancelled/missing result. Только при existing push-to-test событии PR-only recovery job ожидаемо skipped; все исходные5 jobs остаются обязательны, failed recovery не скрывается. Worker/TEST publication restrictions не изменены.

Exact head передаётся через два required string inputs; нет path/draft exclusions, secrets inheritance, write token или PR-triggered publication/deployment. Reusable callers имеют `contents: read`. Existing release/main qualification gates и host verifier не изменены. OCI archive загружается через skopeo, binding проверяет actual manifest/config/filesystem; все recovery modes используют retained IID. Добавлены `uname Linux/x86_64` и actual non-Desktop Linux/AMD64 Engine assertion, JSON evidence сохраняется в production-binding artifact. Functional native storage syscall gate остаётся обязательным.

Регрессии: routing YAML4, Fast gate6, candidate4, CI gate5, policy15, OCI binding9, environment evidence28 — **71 PASS/0 FAIL/0 SKIP**. Temporary publisher guards4 PASS; read-only verify114/group/history/scope PASS. Backend/production helpers не менялись; успешные ARM1149/427/crypto/historical/fault suites не повторяются.

### 34.3. Шесть групп и публикация из обычного Terminal

Проверены зависимости, tests перемещены к своей группе: backend39; deployment15; recovery15; regressions16; runtime fixtures22; CI7 =114. Runtime fixture tests находятся вместе с вызываемыми harness; aggregate recovery test driver идёт последним с CI. Два новых относительно112 source paths — existing Fast gate implementation и его tests. Все112 исходных файлов сохраняются. Current fingerprint `0d8d1718d318d04387a9af158f348fb27bb40c1367e1731360e69dada5e0055d`.

Проверенный одноразовый helper `/tmp/homecloud-pr45-publish-checkpoint.py` не является копией проекта и не входит в commits. Все Git commands выполняются исключительно в основной рабочей директории. Helper проверяет manifest/groups/current branch/HEAD/staged/foreign paths/remote URLs/DRAFT/protection; делает actual fetch, отвергает чужой remote HEAD или изменение test; создаёт шесть Russian commits, проверяет staged/committed bytes и exact per-commit path scope, сохраняет SHA/group/snapshot mapping; отдельным седьмым docs commit сохраняет handoff. Обычный push имеет единственный refspec текущей ветки, без force и follow-tags. Remote ref и DRAFT повторно проверяются после push. Partial failures сохраняют evidence/index, без reset/clean/rollback. Resume допускается только по записанной цепочке собственных SHA.

```bash
(
  set -euo pipefail
  cd ~/Desktop/HomeCloud
  python3 -B /tmp/homecloud-pr45-publish-checkpoint.py --publish
)
```

После docs commit локальный JSON получает actual final HEAD/push status и остаётся dirty — deliberate evidence update без невозможной self-referential commit SHA. Это не qualification PASS. Не создавать бесконечные docs-only pushes ради self-reference. После команды агент сверяет actual remote HEAD и читает реальные Actions jobs/logs/artifacts; run IDs/digests не выдумываются. Новые code fixes допускают последующие согласованные ordinary pushes в той же ветке.

## 35. Installed TEST qualification: технический план, исполнение не разрешено

**Статус: PLAN READY / STAND AND ARTIFACTS NOT PROVIDED / NOT RUN.** Разрешение на checkpoint push не даёт права изменять действующий TEST host, provisioning/установку на стенд или активацию worker. Этот план уточняет `docs/update-install-e2e-stand-plan.md` по actual source; mock tests и core DinD не заменяют installed TEST.

### 35.1. Стенд и неизменённый disk preflight

Отдельный native Linux/AMD64 host без маршрутов/volumes/учётных данных production, rootful local Docker без Desktop/rootless/userns, >=7GiB MemTotal и >=2GiB MemAvailable. Два выделенных ext4/xfs filesystem с различными UUID и `/dev` ancestry, stable serial/WWN, exact mounts, без nested mounts/bind aliases. RAM/capacity/inode budget должен включать две backup generations, DB restore scratch, storage staging+swap, current/target images и retained evidence. Запас считать по измеренным данным, не только example floors.

Read-only survey: uname, Docker info/security/version, findmnt TARGET/SOURCE/FSTYPE/UUID/FSROOT/OPTIONS, lsblk inverse PATH/TYPE/SERIAL/WWN/TRAN/ROTA, by-uuid links, mountinfo, stat UID/GID/mode/dev/ino, free bytes/inodes/RAM. Inventory заполняется из реальных фактов. Loop/tmpfs/directories не выдавать за физические диски; acceptance VM virtual disks требует отдельного решения владельца, physical independence ими не доказана.

После отдельно разрешённого provisioning actual root-owned runtime checkout расположен `/home/hs/homecloud-test`, `.runtime`0700, maintenance0711 root:root, recovery/runtime files0600, root anchors вне checkout. Docker config `/etc/homecloud-test/docker` пуст и root-owned; execution через clean env и fixed local daemon. Новые developer clones/worktrees на Mac запрещены; installed runtime tree стенда — отдельное согласованное deployment provisioning, не рабочая копия для разработки.

Запускать actual wrapper preflight через отдельно проверенный установленный launcher. Эквивалентная диагностическая команда после проверки launcher/checkout:

```bash
sudo env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  /usr/bin/python3 -I -S /home/hs/homecloud-test/deploy/linux/preflight.py \
  --inventory /home/hs/homecloud-test/.runtime/host-disks.json \
  --env-file /home/hs/homecloud-test/.runtime/runtime.env
```

Никаких flags для пропуска disk checks, подложных lsblk/findmnt, patched preflight или enrollment из backup. Без PASS остановиться до установки/записи данных.

### 35.2. Artifact contract и доверенный initial checkpoint

Для initial и target сохранить: source commit/tree IDs; canonical TEST manifest/hash; protected TEST branch evidence/run+attempt; backend/frontend OCI index/platform/config digests, linux/amd64; original archive SHA, loaded binding, provenance statements/subject/materials/build args, scan reports и stage-cache evidence; schema source SHA inventory и actual applied names; exact live image refs/IDs/source labels. Проверять registry и Git bytes actual production verifier-ом, не копировать ожидаемые поля в фальшивый manifest. Signature остаётся UNSIGNED при нынешнем provenance contract; не выдавать digest/source binding за криптографическую подпись.

Positive update требует двух реально eligible protected TEST pairs с одинаковыми operational deploy tree и допустимыми script changes, одинаковым migration inventory, различающимися application image refs/commit. Нынешний PR OCI dry-run qualification artifact не является protected TEST publication. Current modified deploy нельзя подставить в old manifest или подделать API/labels. Если eligible pairs с новой operational boundary ещё не существуют, positive apply остаётся BLOCKED; после отдельно согласованной TEST integration нужны соответствующие qualified artifacts. План не разрешает merge ради получения этих artifacts.

Initial system создаётся только из синтетических users/files/quota/journals; real production backend/frontend/ingress/PostgreSQL, real test HTTPS с проверяемым сертификатом. `.runtime/test-channel/state.json` не придумывать: actual `baseline-inspect` даёт READ_ONLY_PROPOSAL, затем отдельно утверждаются source refs/IDs/migrations и initial adoption. Записать root disk marker и application marker fingerprint, rows/bytes/quota/journals/container IDs before. New FileCopyAdmission migration должна уже принадлежать qualified initial schema; текущий automatic TEST apply не допускает arbitrary schema evolution.

### 35.3. Старый verifier и штатная manual qualification новой boundary

На изолированном старом baseline сохранить exact old anchor/helper bytes и protection evidence. Проверить target с actual artifact/provenance checks. Для changed deploy/scripts tree ожидается отказ `separate/manual qualification required` до pending/stop/backup/rewrite_refs; при ещё неeligible artifact допустим более ранний artifact refusal, но он не доказывает конкретный tree gate. Подтвердить unchanged rows/bytes/images/config/state и absence новых pending/inhibit artifacts. Не править старый verifier/pins для зелёного результата.

Manual qualification — отдельная root provisioning процедура и отдельное согласование, не whitelist exception в normal updater:

1. Independent review exact new operational bytes, Compose overlays, preflight, maintenance/writer helpers и pinned dependency closure. Составить reviewed old→new inventory/digest statement, указать исходный отказ и reviewer/approval identity. Шесть existing pins не пересчитывать автоматически; они фактически unchanged. Изменение anchor bytes потребовало бы нового независимого решения.
2. На disposable stand подготовить verified recovery checkpoint при остановленных writers; подтвердить all-container foreign RW inventory и kernel root lock. Сохранить old root configuration/anchors/state и проверяемый backup вне заменяемых данных. Если pending/uncertain COMMIT/restore artifacts — сначала предусмотренная reconciliation, не чистить вручную ради старта.
3. В явно offline provisioning window установить только отдельно reviewed new operational tree/mount contract из exact approved source; owner/mode/ACL/nlink/ancestor checks, clean Git/source identity, fixed Compose/Docker profile, read-only maintenance bind и real startup gate. Не исполнять непроверенные scripts из incoming tree как root. Не делать automatic chmod/chown repair неизвестного дерева.
4. Actual preflight/startup/native syscall/enrollment/migrations/inhibitor/root lock должны пройти. Снять новый `baseline-inspect` proposal и утвердить только совпадающий initial checkpoint. Bootstrap/new state adoption не смешивать с automatic update success; retain old evidence и no implicit data rollback.
5. Выполнить ниже весь positive/negative/fault campaign. `PROVISIONED=False` и bridge disabled сохраняются; direct trusted installer qualification не даёт права включать worker или действующий TEST bridge. Допуск в существующий host — отдельная операция после независимого review.

### 35.4. Positive apply и доказательства recovery

Перед каждым случаем — известный initial image/schema/state и детерминированный synthetic dataset. После `dry-run` подтвердить отсутствие mutations. Actual `test-apply` через штатный root launcher должен выполнить production backup.sh, independent backup verification, maintenance completion, no-build/no-pull image switch, real backend/frontend/ingress readiness + public HTTPS smoke, exact target images/source/migrations и durable INSTALLED checkpoint. Проверять backup DB rows/file bytes, quota/copy journals, all four services, storage marker identity, no residual pending/permit/staging/swap и expected runtime pins. Повтор same target — ALREADY_INSTALLED без повторного backup/switch.

Fault campaign — fresh disposable reset для каждого случая, actual process/service/network faults, не fake callback PASS:

| Fault | Обязательное доказательство |
|---|---|
| Changed helper/overlay mode/content/symlink/delete, bad/expired/mismatched artifact, wrong platform/source | Отказ до mutation; старые state/data/services сохранены |
| Migration source/applied inventory mismatch | Отказ до backup/switch; не объявлять new-migration apply поддержанным |
| Concurrent Backup/Restore/Update/offline recovery | Один actual operation lock owner; остальные отказывают без побочных эффектов |
| Partial writer stop, foreign RW actor, inherited/orphan writer | Durable inhibit до stop; no backup publication/switch; actual independent Docker mount inventory/root flock |
| Backup staging/corruption/validation/encryption failure | Final artifact не считается complete; marker/receipt/pending retained по фазе; writers не стартуют автоматически |
| SIGKILL после STOP/BACKUP/WRITE_REFS/START/COMMIT_STATE | Actual phase/pending сохранены; повтор apply blocked; rows/bytes/quota/journals/images/config сверены |
| Backend/frontend unhealthy, TLS failure, timeout/lost success ACK | Нет ложного INSTALLED/ROLLED_BACK; retained phase и проверяемая recovery direction |
| Ambiguous COMMIT, stale permit/receipt, root/marker/container replacement | Published inode не удалён; unknown reservation retained; unauthorized migration/start refused |

Operator recovery выбирается по actual pending phase. Pre-start compensation не доказывает data rollback: проверить old exact images/refs/source, migrations/rows/bytes/quota/journal и retained receipt. Post-start failure требует explicit reconciliation и verified Restore при необходимости; не удалять marker/pending/swap как способ допуска. Для восстановленного backup подтвердить exact bytes, old generation rows, consistent quotas/journals и нужный restart; READY-before/after-clear windows и stale migration permits проверяются actual startup/lock attempts. `ROLLED_BACK` допустим только после полного сопоставления данных и checkpoint, не по `docker start`.

### 35.5. Итоговый gate и evidence

Для каждого случая сохранить before/after source/artifacts/real disk inventory, commands/exit codes, run IDs, monotonic deadlines, PG rows/counts/quotas/journals, file SHA/inodes, four container IDs/image refs/status/health, marker/receipt/permit dev/ino/mode/nlink, locks, phase/pending/status, backup identities и cleanup inventory. Запретить secret values в отчётах; держать raw root evidence private, публиковать redacted proof+hash. Cleanup удаляет только созданные campaign resources; никаких production volumes/global prune.

PASS installed TEST возможен лишь при real unchanged preflight, trusted initial adoption, eligible artifacts, actual positive apply/recovery и всех negative faults. Synthetic contracts/current single-ext4 ARM E2E — supporting evidence. Сейчас не предоставлены host/disk inventory, отдельное provisioning/adoption согласование и eligible new-boundary initial/target pairs: **full installed TEST NOT RUN**, worker activation не разрешена.


### Authorized checkpoint source commits (CI still pending)

Source snapshot: `0d8d1718d318d04387a9af158f348fb27bb40c1367e1731360e69dada5e0055d`. Evidence commit SHA is recorded after creation in local JSON.

- `b5d56c2c605348223108979a7d3b7c8c47afc384` Защитить копирование журналом и корневой блокировкой
- `5ec06ecbe8dec791e9ea8af00aa21eb642beae3b` Согласовать режим обслуживания и блокировки в Compose
- `f175185596717c11252584a1acd60e163aaf904b` Защитить этапы восстановления контрольными точками
- `82bbcd917bb70f32befe9eb255ba5806b265fbf0` Проверить отказы и аварийное восстановление хранилища
- `40352fbb0df1b380cc2bf4ea9a076dd1417339ea` Проверить восстановление на изолированном Docker стенде
- `c1673d7b98905e1b179cf0efe8316356c84b362d` Сделать квалификацию OCI обязательной для PR

## 37. Первый actual AMD64/OCI CI: FAIL; проверяемый следующий checkpoint

### 37.1. Реальная публикация и результаты

Terminal создал все6 source commits, exact paths/parents/114 blob hashes сверены. Docs commit остановился на7 Markdown hard-break trailing spaces, строки5–11. Working document исправлен; staged исходный документ ещё содержит старые пробелы. Это не потеря source commits. `git diff --cached --check` не отключался.

Агент выполнил разрешённый обычный `git push --no-follow-tags origin HEAD:refs/heads/миниатюры-файлов-v1`: remote успешно ee84ddd→`c1673d7b98905e1b179cf0efe8316356c84b362d`. Ошибка local origin tracking update возникла уже после успешного push из-за sandbox `.git` permissions. Независимые GitHub PR API/Actions подтвердили exact HEAD, DRAFT, base85578280,32 existing PR commits/151 changed files. Local origin ref может быть старым — использовать actual remote/API, не force-push. Документы пока staged с дополнительными working edits, три чужих untracked сохранены.

| Actual run | Итог на c1673d7 |
|---|---|
|43608761566 — HomeCloud PR Fast + Integration v2, включая required Recovery Qualification |FAIL, завершён |
|43608761453 — Frontend runtime qualification |FAIL, завершён |
|43608761429 — Phase3 host drills |PASS, supporting synthetic/disposable scope, не full installed TEST |
|43608761437 — Ingress runtime qualification |PASS |

Все job IDs/status/failed steps хранятся в JSON `ci.jobs`; actual final job summary также `/tmp/homecloud-pr45-ci-wave1-final-jobs.json`. Parent frontend unit/build/lint и full-history Gitleaks PASS. Parent backend:427 total,424 PASS/3 FAIL; unit1149 total,1147 PASS/2 FAIL. Все пять отказов — child workers require compiled dist, которого fresh CI ещё не создал. Nested duplicates имеют те же причины. Configuration отказывает на missing Linux `/private/tmp`. Required terminal отказывает, поскольку native qualification не прошла; branch protection не обходилась.

Nested image backend: actual native boundary PASS; maintenance supervisor5/5, copy CLI5/5, shared guard8/8, real restore validator7/7 PASS. Полный Backup/Restore остановился ДО disk fixture: Docker20.10 nested load не сохранил registry digest ref stub Node image; `No such image node:...@sha256...`, exit125. Ни plain/encrypted/historical/fault AMD64 roundtrip этим run не прошёл. Прежние ARM результаты сохранены на их snapshots.

### 37.2. Доказанный native host и exact OCI

Actual uname Linux/x86_64, Ubuntu24.04.5, Docker28.0.4. Production runner Node x64, addon loaded, `nativeBoundaryOperational=true`, phase complete: actual native root/directory/devino/flock. Independent raw C compiler probe внутри slim image отсутствует (ENOENT), не выдан за successful raw437 probe. AMD Desktop ENOSYS этим не повторяется: это другой actual native host.

| Role | Platform manifest digest | Config digest | Security verdict |
|---|---|---|---|
| backend |`sha256:2f7ca025a074dc7c34fdd394934a2827499e231c28493fb67efb59eed14bf07b`|`sha256:2964034e75a104e273a4b7dd44087179e1c18ffa24342476a8ade34aec82f5ca`|NO_GO:3 HIGH |
| frontend |`sha256:e0fbf5db2589318ffc554f6b8fa1fb9958076f06bb28d5b8075aba518fca447f`|`sha256:8d71bf4a25951eeb8da450003d8037b51e7e26b9dbdbf18675cec905b90e2504`|NO_GO:3 HIGH |

Оба actual linux/amd64. Source c1673d7 совпал в archive и loaded bindings; actual loaded inspect Os/Architecture/Id проверены, source/platform/config digests согласованы. Binding `LOADED_EXACT_OCI_CONFIG_AND_FILESYSTEM` доказывает идентичность retained candidate, **не security PASS**. Nine small proof/scan ZIPs скачаны и SHA256 сверены с GitHub artifact digest; OCI archives не пересобирались ради проверки.

### 37.3. Локально исправленные причины, ещё не переисполненные в CI

1. В обоих workflows unit/integration выполняют `npm run build` до Jest. Existing later duplicate unit build удалён; compile/type/security checks не отключены. Real crash/SIGKILL tests остаются обязательны. YAML regression проверяет compile-before-test во всех4 job definitions.
2. Cleanup/health/storage fixtures используют standard `TemporaryDirectory` с unique prefixes; production canonical-path guards неизменны.14/14 targeted tests PASS.
3. Host launcher сохраняет exact inspected stub config ID под local fixture RepoTag перед save; alias ID проверяется до build и после nested load вместе с platform. Digest reference не подменяется непроверенным latest, pull/network в nested не добавлены. Launcher12 PASS, runtime context13 PASS, routing5 PASS; no emulation/seccomp waiver.
4. Backend shared base получает signed Alpine exact musl1.2.6-r3/musl-utils1.2.6-r3/zlib1.4-r0; frontend runtime — libxslt1.1.43-r4 с expected-version check. Vendor security data `https://secdb.alpinelinux.org/v3.24/main.json` прочитана, fixes подтверждены. Actual image findings: backend3H, frontend3H, backend deps6H/builder5H. В stages дополнительно old global npm11.21.1 содержит undici6.29.0 findings: backend переведён на уже проверенные frontend/CI npm11.21.2 и SHA256 `8ad8563b81e71b90ef405b140bccf3ba9b5e7884ab210bd49ee4e2f4bc6f61f5`, integrity check ДО выполнения npm сохранён. Installer6 и stage-cache7 regressions PASS.

Текущие binaries/images этих fixes не собраны в sandbox: новый runtime/security PASS ещё не заявляется. Application TypeScript и production fencing/restore logic не менялись; image OS/tooling изменились и требуют фактического нового CI. Manifest118 и две pending groups описаны в JSON. Published snapshot114 `0d8d1718d318d04387a9af158f348fb27bb40c1367e1731360e69dada5e0055d` сохраняется отдельно от pending118 `287deb2427c58d7502370fa1aa8f067b7dc4b62dcae56d11be209c353b6766fd`.

### 37.4. Подтверждённые дополнительные security blockers

| Actual artifact/domain | Открытый результат |
|---|---|
| PostgreSQL16.15 pinned production image |1 CRITICAL/47 HIGH; OS krb5/libxslt/musl/zlib и gosu Go stdlib. Existing exact-binary disposition покрывает лишь один прежний CVE, raw gate не меняет и остальные findings не закрывает |
| Pinned BuildKit worker |8 CRITICAL/132 HIGH: OS packages, OpenSSH, Go stdlib/x-net/go-archive; ordinary source fixes PR45 не устраняют их |
| Backend CI actual rootfs |6 CRITICAL/981 HIGH; среди них injected `/__t` Go/CodeQL/Java/.NET, Debian packages,193 linux-libc-dev findings без fixed version |
| Executed Trivy0.76.0 |3 HIGH: go-jose4.1.5, x/net0.60.0, Go1.27.2; фактически запущенный бинарник проверен по staged/real/postscan SHA |
| Other CI environments/global npm |Actual jobs FAIL, включая provider/tooling domains; новые сканирования не пропущены и не переобъявлены PASS |

Backend environment artifact14119785067 downloaded through GitHub app, ZIP SHA256 `6fd59681b4144378fdcefec2eab366dcefa90a6831ce936f085cf1fdbe97463f` совпал с API. Извлечены только reports/metadata; executed tool binary не запускался. Raw files находятся в `/tmp/homecloud-pr45-ci-c1673d7/14119785067`; остальные scans/bindings в sibling artifact-ID directories.

Строгий full qualification остаётся FAIL даже после подготовки fixture fixes. Нельзя заменить его functional native PASS, удалить metadata из Go binaries, применить ignore-unfixed/широкие CVE исключения, выключить environment scan или допустить changed deployment через old verifier. Подтверждённый scanner finding не объявляется автоматически доказанным exploitability каждого injected tool/header, но без предусмотренного reviewed disposition gate остаётся blocked.

Дальнейший baseline remediation требует actual fixed upstream artifacts/version/build inventory и повторных unchanged scans: проверить официальные BuildKit v0.35.0/Trivy v0.76.2 (release API прочитан), актуальные PostgreSQL minor artifacts и gosu; digest/platform содержимое не угадывать. Official PostgreSQL current Dockerfile16/alpine3.24 содержит PG16.16 и gosu1.19 — один tag/version сам по себе Go findings не закрывает. Если понадобится custom PG/worker/scanner rebuild или новая disposition/provider boundary, сначала подготовить отдельный reviewable contract; current PR permissions/host verifier/security gates не расширять ради PASS. Targeted backend/frontend fixes выше не претендуют на решение этой отдельной baseline проблемы.

### 37.5. Следующая публикация и ограничения

Новый temporary helper `/tmp/homecloud-pr45-publish-fixes.py` подготовлен для12 reviewed paths двумя small Russian code commits и одним handoff evidence commit. Он сохраняет own staged docs, создаёт source commits через `git commit --only` с exact paths; затем restage только двух исправленных handoff docs и повторяет полный cached diff-check. Old helper не использовать: source уже изменился после original six-group snapshot. Утверждённые SHA/parent/path/snapshot записываются в JSON, remote/source/DRAFT/protection проверяются до и после normal push, force/follow-tags/reset/clean отсутствуют. Сам temporary helper не коммитится.

```bash
(
  set -euo pipefail
  cd ~/Desktop/HomeCloud
  python3 -B /tmp/homecloud-pr45-publish-fixes.py --publish
)
```

Требуется обычный Terminal из-за read-only Git metadata. Разрешение пользователя уже есть, повторно не спрашивать. После публикации автономно читать actual new run IDs/jobs/logs/bindings и исправлять runtime причины. Existing security baseline gates остаются обязательны, даже если повторный functional suite пройдёт. Installed TEST — только technical plan35, NOT RUN; B01/B02 OPEN; no merge/deploy/release.


### CI follow-up source commits

- `b9e68fd355ec046f95fb5720e3f277807dba83a8` Исправить подготовку crash workers и перенос образов E2E
- `51a9325f15dedff32e8887222f954cbac1261f04` Обновить уязвимые системные библиотеки образов

Snapshot `287deb2427c58d7502370fa1aa8f067b7dc4b62dcae56d11be209c353b6766fd`; not final qualification; B01/B02 OPEN.
