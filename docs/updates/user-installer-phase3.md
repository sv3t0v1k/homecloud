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
  третьим `-f` при up. Администратор кнопки — `UPDATE_ADMIN_USER_ID`
  (после регистрации владельца, обычно `1`).

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
- Backend jest и frontend vitest — submit с `manifestSha256`, кнопка и
  статусы для release-канала.

Живой прогон (чистая Linux x86_64 машина, опубликованные подписанные
образы) фиксируется отдельным чекпоинтом evidence.

## Границы этапа (осознанно не входит)

- **Автообновление по таймеру** — только кнопка (открытый вопрос 3
  дизайна).
- **Ротация ключей** — Этап 4 дизайна.
- **Расширение UI-статусов** — текстовый словарь фаз, без прогресс-бара.
