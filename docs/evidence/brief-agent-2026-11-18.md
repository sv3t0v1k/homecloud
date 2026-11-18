# Brief для смежного агента — состояние на 2026-11-18 (~12:00 VLAT)

От тимлида-чата. Дерево `~/Desktop/HomeCloud`, ветка `test` сейчас на `7a6a8b2`.
Перед любыми переключениями веток проверяй `git status` — в дереве может быть
незакоммиченная работа.

## Что произошло сегодня (уже решено, не переоткрывать)

1. Установка кандидата `test-ac0be19` на VM120 падала на фазе BACKUP
   (`MANUAL_RECOVERY_REQUIRED`). Корень: `scripts/recovery_storage.py` опознавал
   TEST-канал по литералу `COMPOSE_PROJECT_NAME == "homecloud-test"`, а на VM120
   по плану стенда проект называется `homecloud-e2e-120` → fence уходил в
   RELEASE-ветку. Фикс — PR #56 (ветка `исправить-дискриминатор-test-канала`):
   канал опознаётся по checkout `/home/hs/homecloud-test`, имя проекта —
   legacy-фолбэк.
2. `qualify` стал красным для всех PR: свежая запись Trivy DB
   CVE-2026-112366 (HIGH, без FixedVersion) в devDependency `picomatch`
   build-стадий. Финальный runtime-образ чист. Решение тимлида: build-стадии в
   diagnostic-режиме (влито в test через PR #58).
3. phase3-host-drills флакал: (a) ACL-проверка якоря на overlayfs раннера не
   видела `system.posix_acl_access` — drill перенесён на tmpfs; (b) drill не
   учитывал CI-only whitelist при принятии target gate — добавлена сверка.
   Оба влиты в test через PR #58.
4. VM120 восстановлен на `0452caa` (сервисы healthy). Доступа к хосту сейчас
   нет (тимлид вне сети); хост не трогать.

## Бэклог для тебя (по приоритету)

### A. Trust-переход для установки PR #56 на VM120 (следующий большой шаг)
После merge #56 кандидат **не пройдёт** `target_sources` на VM120:
изменения `scripts/recovery_storage.py` и `scripts/restore_maintenance.py`
вне CI-only белого списка → «root helper tree changed; separate qualification
required». По плану стенда (docs/updates/update-install-e2e-stand-plan.md,
п.2-3) переход = отдельный review точных байт + замена root-owned якорей
(`/usr/local/sbin/homecloud-update-verify`, pinned hash внутри
`deploy/linux/update-host-verify.py::QUALIFIED`) + новая квалификационная
кампания. Это же разблокирует твою ветку `администрирование-пользователей`
(19 коммитов, HEAD `c840e61`), которая меняет 16 scripts-файлов вне белого
списка. Процедура доверенного перехода до конца не определена — её нужно
спроектировать и зафиксировать в docs, прежде чем выполнять.

### B. Гонка discovery в публикации TEST-кандидата
`available.json` на VM120 публиковался по attempt 1 прогона, у которого
attempt 2/3 позже падали; discovery не перепроверяет, что conclusion
изменилась. Код в `deploy/linux/` (update-host-discover.py и смежные) —
trusted-дерево, менять только через квалифицированную процедуру.
Наблюдение: сегодня phase3-host-evidence падал с «Ambiguous or missing
successful TEST run», пока push-прогон свежего HEAD test не завершился —
внешнее состояние, само рассослось.

### C. Недетерминизм gitleaks на синтетических маркерах
Точечно залечен `.gitleaks.toml` (PR #55). Корневой фикс классификатора
`scripts/ci/secret-findings.py` отложен: файл вне CI-only whitelist, правка
ухудшит trust-профиль любого кандидата до проведения доверенного перехода.

## Ограничения
- Коммиты/ветки/PR — только на русском.
- `deploy/` и не-белые `scripts/` в кандидате = неустанавливаемо на VM120.
- Destructive — только с явного «да» тимлида.
- Критичные/безопасностные изменения — с независимым review.
