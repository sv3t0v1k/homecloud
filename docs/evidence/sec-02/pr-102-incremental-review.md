# PR #102: SEC-02.12A/B, проверка после security review

Дата: 2026-11-29. Base `test` — `9c753200b5460738c7ee9a80ef37bc8752260f90`.
Первоначальный HEAD PR — `fbafa841b2007e3c7b2b551e5db4cea8a755f424`.
RELEASE и merge остаются `NO_GO` до нового успешного CI и независимого review.

## SEC-02.12A: связь архивов с опубликованными OCI digest

Проверены исходные локальные файлы в
`/private/tmp/homecloud-ins05.H8CPSU/sec02-postgres.HXsbFt`, а не только
машиночитаемая сводка. SHA256 четырёх архивов совпадают с
`scripts/ci/sec02-candidates.lock.json`:

| Компонент | Исходный архив относительно каталога evidence | SHA256 архива | OCI platform manifest digest |
|---|---|---|---|
| postgres | `postgres-permanent.TpNhjO/postgres-candidate.tar` | `ebeeb4a27d04dd664030924f2c3757f68688d5505eb0b23460a5d7eeb8299329` | `sha256:fbf91774bc5574e34be7404e234da57791fcd6ff9dbc7bd96625eaf2fdddf0ab` |
| buildkit | `buildkit-final.wJaZZ2/buildkit-final.tar` | `aa599e48f8090d7700790c02f660570c2cd97e88a519770fcbd565e1b1234b1c` | `sha256:cd50bcd8315282a6e05a6b1758426fca5fccaf4a136be129e96977f11b57504e` |
| gitleaks | `gitleaks-transport.a1h7X3/gitleaks-transport.tar` | `b91a2d83b0f8ac8d7a51bbf215b964adc0bb16c95dc2041d3aaba2821d7d6607` | `sha256:e86133002f108ce5e58225e0bda5613b42fb58ad7e0f136161a8fa67e3ab6257` |
| compose | `compose-transport.huzDmo/compose-transport.tar` | `79c145e716af46ebadef036cd1dd75fa559abb5229dcb6a18bcb5333fde29662` | `sha256:90572c9597798a70d6d96ccdcebd68a90ed58050730d4f27d63379fb53a3ed28` |

Manifest blob каждого tar совпадает байт в байт с сохранённым
`registry-publication.P3NDK3/{role}.manifest.json`. Все 25 SHA256 рецептов в
lock совпадают с рабочими файлами и commit
`ffc700e8416e45953d7d25031a9f216793c62397`. В последних слоях архивов
точные `gosu`, `buildkitd`, `gitleaks` и `compose` совпадают по SHA256 с
сохранёнными независимо воспроизведёнными бинарниками. Это подтверждает
целостность локальных bytes и совпадение с записанными registry manifests.

**Блокер HIGH остаётся.** В tar нет build-time attestation; в evidence не
найдены подписанная attestation, доверенный ключ или удостоверенная identity
сборщика. Логи сборки упоминают attestation manifest, но он не сохранён вместе
с этими tar. Хеши и совпадение воспроизведённых бинарников не доказывают, кто
собрал опубликованный OCI manifest. Подписывать сейчас запись об этих сборках
как build-time provenance нельзя. Нужна независимая проверка сборки в
доверенном CI по закреплённому рецепту с сопоставлением каждого полученного
platform manifest digest с четырьмя опубликованными, затем проверяемая
подписанная attestation **этой проверки**, с явным типом verification и
fail-closed проверкой доверенной CI identity до исполнения и публикации.
Расхождение digest требует нового квалифицированного образа и pin.

`remote_blobs_verified` в локальном JSON означает заявленную authenticated
blob verification в момент публикации; это неподписанное evidence, а не
доверенная identity сборщика. Анонимный доступ к manifest отдельно не
доказывает анонимную загрузку всех blob. Исторический Docker pull прошёл,
но часть слоёв находилась в кэше, а BuildKit не скачал слои; текущая
анонимная доступность всех blob этим не доказана.

## SEC-02.12B: project-installed apt tools

Существующий `skopeo-closure.py` расширен на `age` с отдельным форматом
evidence и обязательным ожидаемым именем инструмента. Для обоих инструментов
проверяются фактические executables (`age` и `age-keygen` вместе), dpkg owners,
транзитивная apt closure, runtime ELF libraries обоих файлов, signed apt index
и архивы, версия runner, source
commit, run ID и attempt. Новый вызов выполняет строгий HIGH/CRITICAL gate
по rootfs report **до первого запуска** apt-installed `age` или `skopeo` в
соответствующем job. Весь provider-managed Ubuntu по-прежнему сохраняется в
raw scan и не становится предметом этого строгого gate. Исключения CVE не
вводились. Release publisher сохраняет прежний отдельный strict gate.

Ограничение: gate опирается на свежую Trivy DB, полноту OS package inventory
и наличие apt metadata на конкретном runner. Ошибка любого из этих условий
блокирует job. Это не аттестация происхождения самого hosted runner.

## M-01: отложенный остаточный риск

По решению владельца непривилегированная установка зависимостей и сборка
отложены в backlog. Это **не исправлено**. В PR qualification jobs нет
`packages: write` или release signing secret по workflow-коду. Публикация
TEST отделена в `ci-v2-fast.yml` job `test-image`: он запускается только на
push в `test` после gate, но имеет `packages: write` и выполняет BuildKit.
RELEASE публикация и signing находятся в отдельном `release.yml`; доступ к
production VM в проверенных PR workflows не задан. Локальные evidence и
GitHub artifacts имеют hashes, но локальная цепочка custody не подписана.
Эти границы уменьшают воздействие M-01 на PR jobs, однако не устраняют риск
компрометации root-сборки или TEST publisher после merge. Состояние GitHub
environment protection и внешних credentials из одного workflow-кода
проверить нельзя; это отдельная проверка перед решением о RELEASE.
