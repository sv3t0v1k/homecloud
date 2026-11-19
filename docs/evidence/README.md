# Единый индекс qualification evidence

**Индекс актуален на 2026-11-20.** Production **NOT_READY / NO_GO**. Локальная механика не равна реальному target/provider/human acceptance. Актуальные внешние inputs: [master checklist](../runbooks/external-input-master-checklist.md). Standalone procedure: [операторский пакет](../runbooks/go-live-checklist.md).

## Правила раздела

1. **Нейминг новых папок:** `<тема>-YYYYMMDD[-vN]` (например `mount-identity-r2-1b-20261011`). Повторные попытки внутри темы — `<тема>-YYYYMMDD/attempt-N-{failed|success}`. Имена без даты допустимы только для постоянно действующих harness-каталогов (`immutable-release`, `registry-distribution`, `final-prep`).
2. **Active vs archive.** Завершённые квалификации (закрытый PR, без активности более 30 дней) переносятся в [`archive/`](./archive/) отдельным коммитом. Пути, читаемые скриптами и тестами (`immutable-release`, `registry-distribution`, `final-prep`, `d5-1-5-20261014`, отдельные JSON в корне), **не переносятся** независимо от возраста.
3. **Закрытие квалификации = индекс обновлён в том же PR.** Таблицы ниже — единственная точка входа; новое evidence без строки в индексе считается непроведённым.
4. Не копировать keys/credentials/raw request/session data в индекс.

## Активное evidence

| Тема | Сохранённое evidence / воспроизведение | Граница |
|---|---|---|
| Release/build/schema/full-pair rollback | [qualification](./immutable-release/qualification.json), [current](./immutable-release/current-manifest.json), [previous](./immutable-release/previous-manifest.json); `scripts/tests/release-pair-runtime.py` | Immutable local outputs; exact-schema/same application trees; evolving-schema compatibility не доказана |
| Registry | [qualification](./registry-distribution/qualification.json), [current](./registry-distribution/current-manifest.json), [previous](./registry-distribution/previous-manifest.json), [gates](./registry-distribution/gates.tap), [review](./registry-distribution/review.md); `scripts/tests/registry-distribution-runtime.py` | Disposable HTTP provider/clean daemon; production auth/TLS/platform/retention open |
| Final local acceptance/preflight/operator review | [сводка](../runbooks/final-production-acceptance.md), [gates](./final-prep/gates.json), [API/pair](./final-prep/local-production-e2e.json), [browser](./final-prep/browser-acceptance.json), [fresh build](./final-prep/current-build-manifest.json), [cleanup](./final-prep/restore-cleanup-regression.json), [independent review](./final-prep/review.md), [final statuses](./final-prep/final-status.json); `scripts/tests/final-production-e2e.py` | Exact production ingress template/CSP, local hostname+selfsigned TLS; real endpoint/operator acceptance open |
| d5-1 supply-chain wave (октябрь 2026) | [d5-1-5 policy](./d5-1-5-policy-implementation-20261015.md), [independent review](./d5-1-5-policy-independent-review-20261015.md), [secret findings](./d5-1-5-policy-secret-findings-20261015.json), [CI infrastructure](./d5-1-6-ci-infrastructure-20261015.md), [security triage](./d5-1-7-security-triage-20261016.md), [CI minimization](./d5-1-8-ci-minimization-20261016.md), [gosu disposition](./d5-1-8-gosu-disposition-20261016.json), [postgres gosu](./d5-1-10-postgres-gosu-20261017.md), [existing OCI](./d5-1-11-existing-oci-20261017.md), [OCI review](./d5-1-11-existing-oci-review-20261017.md), [postgres residual](./d5-1-11-postgres-residual-20261017.md), [p0c blocked](./d5-1-p0c-postgres-gosu-blocked-20261031.md); скриптовые пути: [d5-1-5-20261014/](./d5-1-5-20261014/) | Закрыто PR #43/#47; raw scan results сохранены, промежуточные OCI TAR — частично (evidence-debt раздела 8.5) |
| Глобальный поиск GS-1A/GS-1B | [gs1a](./global-search-gs1a/acceptance.md), [gs1b](./global-search-gs1b/acceptance.md), [security review gs1b](./global-search-gs1b/security-review.md) | Функциональные сценарии; production-нагрузка не квалифицирована |
| VM120 E2E (TEST-инфраструктура) | [vm120-e2e](./vm120-e2e/), [admin user lifecycle](./vm120-e2e/admin-user-lifecycle-20261120.md) | Ubuntu 24.04 amd64; установленная версия `f1a8f41`; authenticated admin CRUD/UI smoke на VM120 открыт; см. [linux-project-test](../runbooks/linux-project-test.md) |
| Public Folder stage 5 | [public-folder-stage5-20261023](./public-folder-stage5-20261023/) | Канонический контракт — [public-folder-sharing-v1-contract](../public-folders/public-folder-sharing-v1-contract.md) |
| Frontend functional | [frontend-functional](./frontend-functional/) | UI-квалификации; closure-файлы намеренно неотслеживаемые (см. `.gitignore`) |
| Update-механика, текущий статус | [test-channel-v1-operational-20261106](./test-channel-v1-operational-20261106.md), [test-checkpoint-20261030](./test-checkpoint-20261030.md), [d5-1-p0d](./d5-1-p0d/), логи `phase2b-*.log` | TEST установлен вручную (`AUTO_UPDATE=false`); discovery ≠ установка |
| Отчёты агентов | [agent-reports](./agent-reports/) | Рабочие отчёты соседних агентов; не являются qualification evidence без отдельной проверки |

## Архив (завершено, перенесено 2026-11-17)

Перенесено 37 папок; ссылки из документов и скриптов сохранены через `archive/<имя>/`.

| Тема | Сводка |
|---|---|
| 50 ГиБ browser qualification (03–06.10) | [03.10](./archive/browser-50gib-qualification-20261003/report.md), [04.10](./archive/browser-50gib-qualification-20261004/report.md), [06.10](./archive/browser-50gib-qualification-20261006/report.md) + [independent review](./archive/browser-50gib-qualification-20261006/independent-review.md) — IAB/localhost PASS; Safari 50 ГиБ и production UNQUALIFIED |
| Docker consolidation | [compose-20261013](./archive/compose-20261013/report.md) |
| Backup/Restore этап D1 | [d1-backup-restore-20261013](./archive/d1-backup-restore-20261013/report.md); каноника — [backup-and-restore](../runbooks/backup-and-restore.md) |
| Docker-first подготовка D3 | [d3-docker-first-20261013](./archive/d3-docker-first-20261013/report.md), [d3-preparation](./archive/d3-preparation-20261013/report.md) |
| d5-1 wave (13–14.10) | [d5-1-20261013](./archive/d5-1-20261013/report.md), [d5-1-1](./archive/d5-1-1-20261014/report.md), [d5-1-2](./archive/d5-1-2-20261014/report.md), [d5-1-12](./archive/d5-1-12/report.md), [d5-1-13](./archive/d5-1-13/report.md) |
| Frontend SSD integration | [frontend-ssd-integration-20261013](./archive/frontend-ssd-integration-20261013/report.md) |
| Large files / rate limit | [large-file-remediation-20261004](./archive/large-file-remediation-20261004/report.md), [large-transfer-rate-limit-20261005](./archive/large-transfer-rate-limit-remediation-20261005/report.md) |
| Local release v0.9.0-local.1 | [local-release-20261006](./archive/local-release-20261006/report.md) — backend 63 suites/825, PostgreSQL 7 suites/68, frontend 19 files/218 на дату gate |
| Mount/identity R2 | [mount-identity-r2-1b](./archive/mount-identity-r2-1b-20261011/report.md), [persistent-identity-r2-1](./archive/persistent-identity-r2-1-20261011/report.md) |
| Multi-storage schema/registry | [multi-storage-schema](./archive/multi-storage-schema-20261010/report.md), [multi-storage-registry](./archive/multi-storage-registry-20261010/report.md) |
| Offsite recovery / custody | [offsite-recovery](./archive/offsite-recovery/) — RTO ≈31 s, candidate 12 min unapproved; физический offsite не квалифицирован |
| Secure filesystem adapter (семейство R1) | [boundary](./archive/secure-filesystem-boundary-20261011/report.md), [r1](./archive/secure-filesystem-adapter-r1-20261011/report.md), [implementation-r1](./archive/secure-filesystem-adapter-implementation-r1-20261011/report.md), [native-amd64-r1q](./archive/secure-filesystem-adapter-native-amd64-r1q-20261011/report.md), [home-server-r1q](./archive/secure-filesystem-adapter-home-server-r1q-20261011/report.md), [home-server-native-r1q](./archive/secure-filesystem-adapter-home-server-native-r1q-20261011/report.md) |
| Secure workspace activation | [secure-workspace-activation-20261010](./archive/secure-workspace-activation-20261010/report.md) |
| SSD/HDD stages | [ssd-hdd-integration](./archive/ssd-hdd-integration-20261012/report.md), [stage1](./archive/ssd-hdd-stage1-20261012/report.md), [stage2](./archive/ssd-hdd-stage2-20261012/report.md), [stage23](./archive/ssd-hdd-stage23-20261012/report.md) |
| Trusted attestation R2-1C | [trusted-attestation-r2-1c-20261012](./archive/trusted-attestation-r2-1c-20261012/report.md) |
| Upload workspace / UX | [upload-workspace-20261010](./archive/upload-workspace-20261010/report.md), [universal-storage-upload-ux-20261005](./archive/universal-storage-upload-ux-20261005/report.md) |
| Scheduler/alerts | [scheduler-alerting](./archive/scheduler-alerting/) — disposable PID1/loopback; human recipient/target wrapper open |

Все `/private/tmp`, `/tmp`, `/private/var/folders` и `/var/folders` raw paths в исторических документах **NON_AUTHORITATIVE / EPHEMERAL**: не prerequisites оператора и не гарантия доступности архивного evidence. Сохранённые repo JSON/тексты authoritative только в явно указанном local scope. Harness позволяет повторить процедуру, но не создаёт отсутствующие historical raw snapshots задним числом.

Fresh supplemental mechanics: [cert native bind runtime](./final-prep/cert-runtime.json), [two offsite recovery runs](./final-prep/offsite-recovery.json). Локальные scope и cleanup указаны в каждом JSON; human/physical independence не подменяется.
