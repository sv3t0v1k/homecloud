# Самообновление пользовательского сервера — Этап 3

Статус: реализация (2026-11-25). Основание: [`user-update-channel-design.md`](./user-update-channel-design.md), Этап 3; продолжение [`user-installer-phase2.md`](./user-installer-phase2.md).

## Цель

Обновление установленного release-сервера в одно действие: кнопка
«Установить» в веб-интерфейсе → заявка хосту → проверка подписи релиза
на хосте → переключение на новые образы → smoke-проверка → откат при
отказе. Без ssh на сервер пользователя.

## Контур доверия

Заявка от backend к хосту содержит **только** `manifestSha256` (64 hex) —
никаких URL, тегов и команд. Доверие возникает на хосте и только через
подпись Ed25519:

1. Worker перебирает опубликованные релизы GitHub и проверяет подпись
   `release-lock.json.sig` ключом `/etc/homecloud/release-public.b64`
   (openssl 3, `pkeyutl -rawin`). Релиз с невалидной подписью обрывает
   перебор (fail-closed).
2. Идентичность релиза — sha256 канонического JSON lock, та же функция,
   что в `scripts/ci/release.py identity()`. Заявка совпадает с
   идентичностью подписанного lock — иначе отказ.
3. Backend (`updates.service.ts`) независимо проверяет подпись до того,
   как показать кнопку; хост не доверяет этой проверке и повторяет её.

## Компоненты

| Файл | Роль |
|---|---|
| `deploy/user/update-worker.py` | Хостовый worker (root). Режимы: `install` (заявка из inbox), `archive` (ротация квитанций, маркер `archiving.json` + resume после краха), `bootstrap` (первичная привязка installed-lock по digest-refs из runtime.env). |
| `deploy/user/systemd/homecloud-user-update.path` + `.service` | Запуск `install` при появлении заявки в inbox. oneshot, ProtectSystem=full, PrivateTmp. |
| `deploy/user/systemd/homecloud-user-update-archive.service` + `.timer` | Архивация квитанций: через 2 минуты после загрузки и далее каждые 2 минуты. |
| `docker-compose.production-updates.yml` | Третий compose-файл release-канала: проброс bridge-env в backend и монтирование inbox (rw) / status (ro). `volumes: !override` сохраняет все 7 production-монтов. |

Backend пишет заявку в `/var/lib/homecloud-update/inbox/request.json`,
читает квитанции из `/var/lib/homecloud-update/status/`. Хост пишет
`status/receipt.json` и `status/installed-lock.json`.

## Поток установки

1. UI (владелец): кнопка «Установить» у доступного подписанного релиза.
2. Backend: заявка `{format, manifestSha256}` в inbox, статус QUEUED.
3. systemd path → worker `install`: VERIFY_TRUST → FETCH_MANIFEST →
   VERIFY_IMAGES (digest-refs lock) → WRITE_REFS (атомарная перезапись
   `RELEASE_*_IMAGE` в `/etc/homecloud/runtime.env`) → compose pull/up →
   START_SERVICES → SMOKE (HTTPS + сервисы) → INSTALLED/COMPLETE.
4. Отказ после переключения: ROLLBACK (восстановление прежних refs, up,
   повторный smoke). Откат успешен — STOP/ROLLBACK; откат не удался —
   MANUAL_RECOVERY_REQUIRED.
5. Квитанция RUNNING старше 30 минут или с битым `updatedAt` —
   MANUAL_RECOVERY_REQUIRED/STALE_RUN: повторный запуск worker не
   продолжает прерванную установку молча.

Тексты фаз в UI: `frontend/src/account/UpdatesSection.tsx` (словарь
`phases`, включая ROLLBACK, STALE_RUN, BOOTSTRAP).

## Провижининг установщиком

`deploy/user/install.sh` (release-канал) дополнительно:

- раскладывает `/etc/homecloud/update-worker.json` (0600),
  `/etc/homecloud/release-public.b64`, worker в
  `/usr/local/sbin/homecloud-user-update` (0700), 4 systemd-юнита;
- создаёт `/var/lib/homecloud-update/{inbox,status}` (inbox
  0770 root:65533 — пишет контейнер backend);
- фаза 7 после старта: `homecloud-user-update bootstrap` — привязка
  installed-lock к установленным образам (точное совпадение digest-refs
  с подписанным релизом), затем `systemctl enable --now` для path и
  archive.timer. Отказ bootstrap/systemd — предупреждение с командами
  повтора, установка не откатывается;
- `UPDATE_INSTALL_BRIDGE_ENABLED=false` в runtime.env по умолчанию
  (fail-closed); bridge включает `docker-compose.production-updates.yml`
  (`"true"`), который подключается флагом `--updates` preflight и
  третьим `-f` при up. Администратор кнопки — `UPDATE_ADMIN_USER_ID`,
  автоматически привязанный к фактическому ID первого владельца.

Preflight проверяет контракт bridge (режим `release_updates`): тройка
env-путей inbox/status/installed-lock, непустой
`UPDATE_RELEASE_PUBLIC_KEY`, bridge только с каналом release|test.

## Проверки

- `deploy/user/test_update_worker.py` — 28 сценариев: happy path с
  подписью настоящим `release.py sign-lock` (байтовая совместимость с
  CI), отказы подписи/идентичности, откат, архив с resume, stale-receipt,
  bootstrap. Требуется `HOMECLOUD_OPENSSL` (openssl 3).
- `deploy/linux/test_preflight.py` — режим `release_updates`, реальный
  трёхфайловый compose merge.
- `deploy/user/test_generate.py` — контракт провижининга worker-артефактов.
- `deploy/user/test_bootstrap.py` — 13 сценариев: подписанный happy path,
  отказ при подмене исходника/подписи/тега, `--ref` без подписи,
  защита распаковки от traversal. Требуется `HOMECLOUD_OPENSSL` (openssl 3).
- Backend jest и frontend vitest — submit с `manifestSha256`, кнопка и
  статусы для release-канала.

Живой прогон (чистая Linux x86_64 машина, опубликованные подписанные
образы) фиксируется отдельным чекпоинтом evidence.

## Установка одной командой (bootstrap по URL)

Репозиторий клонировать не нужно — bootstrap сам скачивает и проверяет
копию, раскладывает её в фиксированный системный каталог (по умолчанию
`/opt/homecloud/repo` — рядом с данными; не текущий каталог терминала:
на путь ссылаются compose-проект и worker обновлений, он должен быть
стабильным) и запускает установщик:

Без `--tag` bootstrap выбирает последний опубликованный стабильный RELEASE.
GitHub endpoint `releases/latest` исключает предварительные версии.

В период beta необходимо явно указать тег опубликованной подписанной
версии (`vX.Y.Z-beta.N`). Например, после публикации `v0.9.0-beta.1`:

```bash
curl -fsSL https://raw.githubusercontent.com/sv3t0v1k/homecloud/main/deploy/user/bootstrap.sh \
  -o /tmp/homecloud-bootstrap.sh && \
  sudo sh /tmp/homecloud-bootstrap.sh --tag v0.9.0-beta.1 --interactive
```

После появления стабильного RELEASE тег можно опустить:

```bash
curl -fsSL https://raw.githubusercontent.com/sv3t0v1k/homecloud/main/deploy/user/bootstrap.sh \
  -o /tmp/homecloud-bootstrap.sh && \
  sudo sh /tmp/homecloud-bootstrap.sh --interactive
```

Для полностью автоматической установки необходимо явно передать
`--defaults` и, если требуется, файл `--answers`.
Канал TEST требует явного `--channel test`, `--ref` и проверенной
пары TEST-образов через `--images` или ввод установщика.

Доверие: релизный тег резолвится из GitHub Releases, затем
`bootstrap.py` скачивает `release-lock.json` + подпись, проверяет
подпись Ed25519 ключом релизов и **хэши всех исходников по подписанному
lock** (включая файлы установщика — они входят в `SOURCE_PATHS`
`scripts/ci/release.py`), и только после этого распаковывает архив и
запускает установку. Образы для release-канала берутся из подписанного
lock автоматически (вопрос про `--images` не задаётся). Сами
`bootstrap.sh`/`bootstrap.py` при запуске по pipe доставляются по HTTPS и
являются единственной TOFU-точкой. Для `--ref` (test-канал) проверка
подписи невозможна — выводится явное предупреждение.

## Границы этапа (осознанно не входит)

- **Автообновление по таймеру** — только кнопка (открытый вопрос 3
  дизайна).
- **Ротация ключей** — Этап 4 дизайна.
- **Расширение UI-статусов** — текстовый словарь фаз, без прогресс-бара.


## Первоначальный запуск — исправления INS-04

- Генератор создаёт логический `.homecloud-storage-identity` с точным
  содержимым StorageMountRegistry, правами 0600 и UID/GID backend.
- Установщик проверяет интерактивный ввод портов.
- До запуска frontend и ingress создаётся первый ADMIN штатным
  admin-bootstrap CLI. Backend останавливается для освобождения root fence.
- Пароль вводится дважды непосредственно в CLI, без argv, env и файлов.
- ID единственного активного ADMIN подтверждается через PostgreSQL
  и атомарно записывается в runtime.env.
- Публичная регистрация остаётся отключённой.
- Для установки с запуском необходим TTY, в том числе с --defaults.
  Режим --no-start не создаёт администратора.
- TEST получает доступ к разделу обновлений, но существующий
  host-side TEST update bridge автоматически не активируется.
- Production-логгер сохраняет фильтрацию секретов и допускает только
  явно перечисленные диагностические сообщения startup.
