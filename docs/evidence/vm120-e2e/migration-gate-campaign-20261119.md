# Кампания VM120: переход на 97c134a заблокирован migration-gate — 2026-11-19

Стенд: vm120 (`homecloud-e2e`, `ubuntu@192.168.3.117`), checkout `/home/hs/homecloud-test`,
compose-проект `homecloud-e2e-120`. Владелец: Alex. Оператор: тимлид-агент.

## Цель

Установить TEST-кандидата `97c134ad2b9e5631b9727a445b5a56cbb9793218`
(squash PR #54, администрирование пользователей 01.5A–01.5D, **34 миграции**)
поверх установленного `438fd44` (**31 миграция**). Артефакт: CI run 44463041790,
`test-channel-1`, artifactId 14501705229,
`manifest_sha256 eeb63cbe33a5253be8d80f592f6e151a7413c51f31aca258bc23dce6d92d7de3`.

Предшественники в тот же день: PR #66 (nginx 1.30.6 → 1.30.7, пять HIGH CVE)
влит в test как `7b04414`; qualify-workflow обновлены (версии и ревизия
пакета `nginx-1.30.7-r1`).

## Исходное состояние (зафиксировано 08:31:16Z)

- Бэкап якорей: `/root/anchor-backup-20261119T083116Z/` (`anchors.sha256`,
  `checkout.head` = `438fd44…`, установленная версия совпадает).
- pending-транзакции нет, git-дерево чистое, 4 контейнера healthy.
- Окно `homecloud-update-admission.path` открыто на время кампании.

## Попытка 1 (08:23:58 → 08:24:05Z): STOP на VERIFY_TRUST

Заявка в inbox (`homecloud-update-request-v1`, manifestSha256 выше) принята
admission; мост остановился на VERIFY_TRUST. Причина: trust gate
`target_sources` (`update-host-verify.py:126–139`) требует, чтобы diff
`scripts/` между установленным и целевым коммитами входил в
CI_ONLY_SCRIPT_CHANGES; PR #54 меняет recovery-скрипты вне белого списка —
отказ по дизайну («root helper tree changed; separate qualification required»).

Квитанция: `status/archive/20261119T083327Z-STOP-verify-trust-old-anchors.json`.

## Шаг 4 процедуры: передвижка checkout-бейзлайна (08:31–08:33Z)

- `git fetch --no-tags origin test`, ff-only merge `438fd44 → 97c134a`.
- Дерево `deploy/` не менялось (tree-хэши `9bc5a6e1…` идентичны) — замена
  root-якорей **не потребовалась**.
- Сверка QUALIFIED-хэшей с checkout: все шесть helper'ов совпали побайтово
  (root-boundary `f8199f84…`, admission `51cda835…`, update_evidence
  `66e8d393…`, update_source `2bd35239…`, provenance `40b97dd4…`,
  test-channel contract `45819750…`).
- Синтетика: discovery перепубликовал `available.json` (commit 97c134a,
  34 миграции); верификатор без заявки — STOP (fail-closed, exit=1).
- Контейнеры на прежних пинах, HTTPS не тронут.

## Попытка 2 (08:33:27 → 08:33:59Z): MANUAL_RECOVERY_REQUIRED на INSTALLER

Диагностика (dry-run с traceback): `project-test.sh preflight` → отказ
`Не прошла операция: docker`. Причина: preflight делает `docker image inspect`
всех образов конфига, а новый ingress-пин
`nginx:1.30.7-alpine3.24-slim@sha256:e2fc2666…` (из PR #66) на стенде
отсутствовал. После ручного `docker pull` по дайджесту preflight PASS.

Квитанция: `status/archive/20261119T084332Z-MANUAL_RECOVERY-installer-preflight-image.json`.

Вывод для runbook: при смене ingress-пина перед заявкой скачать новый образ
на стенд (preflight не скачивает сам).

## Попытка 3 (08:44:02 → 08:44:04Z): MANUAL_RECOVERY_REQUIRED на INSTALLER

Dry-run с traceback: `plan()` (`test-channel.py:320–322`) →
`migration source/applied mismatch; automatic install blocked`.
Установленные 31 миграция != целевые 34. Отказ **до** бэкапа и любых
мутаций — pending.json не создавался.

Это задокументированное ограничение контракта: `update-install-e2e-stand-plan.md`,
п. 21 — установщик требует совпадения миграций до установки; apply с новыми
миграциями требует separately reviewed contract change. Сопутствующий
backend-гейт `host-test-candidate.ts` (exact-migrations) по той же причине
скрывает такого кандидата из UI.

Квитанция: `status/archive/20261119T085032Z-MANUAL_RECOVERY-migration-gate-31to34.json`.

## Финальное состояние (08:50Z)

- Установлено: `438fd44` (31 миграция) — не тронуто; данные не менялись.
- Checkout HEAD: `97c134a` (бейзлайн передвинут; следующий переход после
  контрактного изменения начинается с этого состояния).
- 4 контейнера healthy, публичный HTTPS 200.
- Окно `homecloud-update-admission.path` закрыто (`disable --now`),
  inbox пуст, pending.json отсутствует, все три квитанции сведены в архив.
- На стенде дополнительно лежит pulled ingress-образ nginx 1.30.7 (amd64).

## Следующий шаг (владельцу поручено соседнему агенту)

Контрактное изменение установщика: миграционный apply внутри транзакции
(добавление миграций, fail-closed, E2E-drill'ы 31→34, обновление плана стенда
и процедуры перехода). После ревью и зелёного CI — повторная кампания
на свежем кандидате.
