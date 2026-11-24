# Self-service UI-обновление VM120 — первый автоматический цикл (2026-11-24)

## Контекст

После trusted-перехода (PR #91, evidence `trusted-transition-20261124.md`) владелец нажал
кнопку обновления в административном UI. Заявка попала в host inbox, но не обрабатывалась,
поскольку `homecloud-update-admission.path` и `homecloud-update-archive.timer` были выключены
(так было зафиксировано процедурой перехода). Владелец принял решение: admission listener
должен быть постоянным single-slot listener для явных admin-only UI-заявок; ручное
открытие/закрытие «окна» не требуется — окно равно жизненному циклу одной заявки.

PR #92 («Упростить автоматическое окно TEST-обновления») фиксирует эту семантику в коде
и документации. Настоящий evidence фиксирует первый полный live-цикл по этой модели.

## Исходное состояние

- VM120: `ubuntu@192.168.3.117`, checkout `/home/hs/homecloud-test`, compose `homecloud-e2e-120`.
- Установлен: `84fd07db57cb36ab4cb5383e28484e37352a6114`.
- Candidate от discovery: `f5ae4fbbb94776bf0ff7c9909d070966d12d92f7`, manifest
  `c43ce7f3320dde634787097210a03ff88fe658cafef2e3c4ef4ae066a19a806a`,
  run `45365777095`, artifactId `14907181685`.
- Inbox заявка (создана UI-действием владельца, mtime `2026-11-24 09:43:38Z`):

```json
{"format":"homecloud-update-request-v1","channel":"test","manifestSha256":"c43ce7f3320dde634787097210a03ff88fe658cafef2e3c4ef4ae066a19a806a"}
```

- `pending.json` отсутствовал, 4/4 контейнера healthy; listener и timer — `disabled/inactive`.

## Действие

`systemctl enable --now homecloud-update-archive.timer homecloud-update-admission.path`
(2026-11-24 ~10:23 UTC). Никаких других ручных шагов не выполнялось — заявка обработана
полностью автоматически.

## Ход цикла (журнал VM, UTC)

| Время | Событие |
|---|---|
| 10:23:32 | admission принял заявку из inbox → OnSuccess → install стартовал; timer-driven archive — no-op |
| 10:24:32, 10:25:33 | timer-driven archive во время работы install — STOP «could not be archived» (шум ретраев таймера 1 min; install в полёте) |
| 10:25:46 | install завершён успешно (25.4 s CPU), контейнеры пересозданы |
| 10:26:33 | archive успешно свёл terminal receipt в `status/archive/`; `pending.json` отсутствует, inbox пуст |

## Итоговое состояние (проверено фактически)

- `installed.json` → gitSha `f5ae4fbbb94776bf0ff7c9909d070966d12d92f7` (= защищённый `test` после PR #91).
- Checkout `/home/hs/homecloud-test` → `f5ae4fbbb94776bf0ff7c9909d070966d12d92f7`.
- Inbox пуст; `pending.json` отсутствует (host в NO_JOB); archive receipt записан.
- 4/4 контейнера healthy (frontend/backend/ingress пересозданы ~10:25 UTC, db — без перезапуска).
- `homecloud-update-admission.path` — `enabled/active` (навсегда вооружён для следующих UI-заявок);
  `homecloud-update-archive.timer` — `enabled/active`; `AUTO_UPDATE=false` сохраняется
  (автоматической установки по расписанию нет — только явные UI-заявки).

## Известные замечания

1. Timer-driven archive раз в минуту во время полёта install фиксирует STOP-записи
   «completed TEST update could not be archived». Это шум ретраев: итоговая архивация
   после завершения install успешна. Кандидат на улучшение: пропуск archive, пока
   install service активен.
2. Установка занимает ~2 мин 14 s wall-time (25 s CPU) с коротким недоступом UI
   на пересоздание контейнеров — штатно для текущего контура.

## Вывод

Self-service TEST-обновление через UI работает end-to-end без ручного управления окном:
UI-заявка → постоянный admission listener → одна верифицированная установка → архивация
receipt → NO_JOB. Ручное `systemctl enable/disable` admission больше не требуется.
