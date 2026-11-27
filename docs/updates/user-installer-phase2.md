# Пользовательский установщик — Этап 2, инкремент 1

Статус: реализация (2026-11-24). Основание: [`user-update-channel-design.md`](./user-update-channel-design.md), Этап 2.

## Цель

Первичная установка HomeCloud на чистый Linux x86_64 сервер одной командой —
с вопросами оператора там, где ответ нельзя угадать, и полностью автоматически
в режиме `--defaults`. Без ssh-оператора и без ручного выполнения runbook.

## Установка

```bash
# Интерактивно: скрипт задаёт вопросы, Enter принимает безопасное умолчание
sudo ./deploy/user/install.sh

# Полностью автоматически (умолчания, без вопросов)
sudo ./deploy/user/install.sh --defaults

# Без запуска (только конфигурация и preflight)
sudo ./deploy/user/install.sh --no-start
```

Параметры: `--root <dir>` (умолчание `/opt/homecloud`), `--name <project>`,
`--channel release|test` (канал обновлений, умолчание `release`),
`--answers <file.json>` (готовые ответы, вопросы не задаются),
`--images backend,frontend` (образы в неинтерактивном режиме).

## Канал обновлений и подпись релизов (Этап 1 дизайна — реализован)

- Каждый релиз CI подписывает `release-lock.json` ключом Ed25519
  (команда `release.py sign-lock` в `release.yml`); подпись публикуется
  ассетом `release-lock.json.sig`. Без секрета
  `RELEASE_SIGNING_PRIVATE_KEY_B64` релиз не создаётся (fail-closed).
- Публичный ключ хранится в репозитории: `deploy/user/release-public.b64`
  (SPKI DER, base64). Он входит в source contract релизного lock
  (`SOURCE_PATHS`) — подмена ключа видна в хэшах релиза.
- Backend (`updates.service.ts`) доверяет релизу только при валидной
  подписи точных байт lock репозиторным ключом; без настроенного ключа
  release-канал отвечает `check_unavailable`, неподписанные и
  подписанные чужим ключом релизы пропускаются.
- При установке выбирается канал: вопрос в интерактивном режиме
  (умолчание `release` — стабильные релизы) или `--channel`.
  Установщик записывает `UPDATE_CHANNEL` и `UPDATE_RELEASE_PUBLIC_KEY`
  в `runtime.env`; `docker-compose.production.yml` пробрасывает их
  в backend.
- Проверка подписи: `scripts/ci/test-release-sign.py` — эталонный вектор
  RFC 8032 (побайтовое совпадение подписи), roundtrip, отказы при подмене
  lock, чужом ключе, отсутствии секрета и короткой подписи.

## Архитектура: три фазы, каждая fail-closed

| Файл | Роль |
|---|---|
| `deploy/user/probe.py` | Только чтение: архитектура, RAM, Docker/compose, диски (`lsblk`), mounts, занятые TCP-порты, основной IP. Строгий JSON-контракт, runner инъектируется для тестов. |
| `deploy/user/install.sh` | Оркестратор: probe → вопросы с умолчаниями → generate → **pull** (preflight требует локальные образы) → **preflight** → up → bootstrap обновлений и systemd (release-канал) → сводка. POSIX sh, `set -eu`, чистый PATH. |
| `deploy/user/generate.py` | Из ответов + плана генерирует артефакты, которые runbook готовил руками: `/etc/homecloud/runtime.env` со свежими секретами, `/etc/homecloud/host-disks.json` (UUID + serial), startup-gates (формат `startup-gate.sh`), volume markers, дерево каталогов с точными UID/GID и правами, self-signed TLS с SAN. Для release-канала добавляет артефакты самообновления (Этап 3). Режимы `plan` (JSON без секретов) и `apply`. |

Preflight — существующий `deploy/linux/preflight.py`, конвейер не ослаблен:
установщик только производит входные данные для него.

## Границы инкремента (что осознанно не входит)

- **Root-якорь на хосте пользователя** — ключ берётся из репозитория при
  установке; доставка ключа независимым каналом и его ротация — Этап 4
  дизайна. Подпись релизов и её проверка в backend уже реализованы
  (см. раздел выше).
- **Публикация bootstrap по URL** (одна команда без клонирования репозитория)
  — реализовано: `deploy/user/bootstrap.sh` + `deploy/user/bootstrap.py`,
  см. раздел «Установка одной командой» в
  [`user-installer-phase3.md`](./user-installer-phase3.md).
- **ACME/Let's Encrypt** — сейчас self-signed для IP/домена; выпуск
  настоящего сертификата — отдельная задача после установщика.
- **Автовыбор дисков** — сейчас UUID/mount спрашиваются; автовыбор кандидата
  из probe возможен, но требует отдельной квалификации UX (ошибка выбора
  диска непоправима, поэтому по умолчанию спрашиваем).
- **Обновление установленного сервера** — реализовано в Этапе 3,
  см. [`user-installer-phase3.md`](./user-installer-phase3.md).

## Проверки

Синтетические тесты без root, Docker и Linux-утилит:
`deploy/user/test_probe.py` (контракт опроса), `deploy/user/test_generate.py`
(контракт артефактов и отказы на невалидных ответах). Живой прогон
установщика требует чистой Linux x86_64 машины и опубликованных образов —
фиксируется в evidence отдельным чекпоинтом.

## Безопасность

- Секреты генерируются `secrets.token_hex(32)`, только в `runtime.env`
  root:root 0600; режим `plan` секреты не печатает.
- Маркеры 0400, gates 0644 root:root — точно как в runbook.
- Всё fail-closed: probe без lsblk — STOP; generate отвергает невалидные
  ответы; preflight отказ = установка не продолжается.
