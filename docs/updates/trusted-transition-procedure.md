# Процедура доверенного перехода VM120 после батча trusted-правок

Статус: утверждённая процедура (2026-11-18). Владелец: Alex.
Основание: план стенда `docs/updates/update-install-e2e-stand-plan.md`, п. 2–3
("Any trusted helper change requires a separate review and root-owned anchor
replacement before a new qualification campaign").

## 0. Зачем это

Trust gate VM120 принимает кандидата только при неизменных деревьях `deploy/`
и `scripts/` (вне CI-only белого списка). Батч trusted-правок (ветка
`батч-trusted-правок-и-переименование`) законно меняет оба дерева, поэтому
после его влития кандидат **неустанавливаем** до проведения перехода.
Переход = принять новые деревья как новый доверенный базовый уровень:
заменить root-якоря, передвинуть checkout-бейзлайн, прогнать квалификацию.

Важно: рабочее приложение (контейнеры) при переходе **не трогаем**. Версия
приложения задаётся пинами образов в `.runtime/runtime.env`; смена версии
произойдёт штатно — установкой кандидата через UI.

### Миграционный контракт после изменения 2026-11-19

TEST-кандидат с новыми миграциями теперь является штатным путём, а не только
кандидат с совпадающим набором миграций. Разрешены точное совпадение или строгое
добавление: все установленные записи `{name,file,sha256}` сохраняются без
изменений, а applied-набор перед установкой точно равен установленному checkpoint.
Удаление, замена, переименование, изменение источника и applied-drift отклоняются
до backup. Backend-гейт помечает такой путь как `additive-migrations`.

После проверенного `BACKUP` и `WRITE_REFS` фаза `MIGRATION_APPLY` запускает только
`db` и новый `backend`. Entrypoint backend выполняет TypeORM
`migration:run --transaction all` до запуска API. Установщик проверяет образ backend
и точное равенство applied-миграций манифесту, затем переводит транзакцию в
`START_SERVICES` и повторяет проверку после полного запуска. Backup остаётся снимком
**старой** схемы и проверяется против прежнего active-checkpoint.

Любая ошибка или SIGKILL в `MIGRATION_APPLY` требует `MANUAL_RECOVERY_REQUIRED`;
`pending.json` сохраняется, повторный apply заблокирован до `recovery-inspect` и
ручного reconciliation. Down-миграции и автоматический перезапуск старых контейнеров
не являются откатом: схему восстанавливают только из проверенного backup.

Этот батч меняет доверенные `deploy/linux/test-channel.py` и
`deploy/linux/update-install-bridge.py`. QUALIFIED-хэши намеренно не обновлены в
рабочем дереве: перед кампанией обязателен независимый review точных байтов и
trusted transition с заменой соответствующих root-якорей и checkout-бейзлайна.
Локальные mocked drills не заменяют реальные миграционные E2E на изолированном стенде.

## 1. Предусловия

1. Батч влит в `test`; push-прогон зелёный; опубликован кандидат `test-<SHA>`.
2. Независимый review точных байтов диффа батча (правило 4 AGENTS.md) —
   выполнен соседним агентом, замечания закрыты.
3. SSH-доступ к vm120 (`ubuntu@192.168.3.117`), sudo без пароля.
4. Согласие владельца на операцию (explicit «да») и выбранное окно.
5. На стенде нет незавершённой транзакции установки:
   `ls /home/hs/homecloud-test/.runtime/test-channel/pending.json` не существует.

## 2. Зафиксировать исходное состояние

```bash
ssh ubuntu@192.168.3.117
SNAP=$(date -u +%Y%m%dT%H%M%SZ)
sudo mkdir -p /root/anchor-backup-$SNAP

# Текущие якоря и их хэши
sudo sha256sum \
  /usr/local/sbin/homecloud-update-verify \
  /usr/local/sbin/homecloud-update-install \
  /usr/local/sbin/homecloud-update-archive \
  /usr/local/sbin/homecloud-update-discover \
  /usr/local/libexec/homecloud/update-admission.py \
  /usr/local/sbin/homecloud-test-launcher | sudo tee /root/anchor-backup-$SNAP/anchors.sha256

sudo cp -a /usr/local/sbin/homecloud-update-verify /usr/local/sbin/homecloud-update-install \
  /usr/local/sbin/homecloud-update-archive /usr/local/sbin/homecloud-update-discover \
  /usr/local/libexec/homecloud/update-admission.py /usr/local/sbin/homecloud-test-launcher \
  /root/anchor-backup-$SNAP/

# Checkout и статус
sudo git -C /home/hs/homecloud-test rev-parse HEAD | sudo tee /root/anchor-backup-$SNAP/checkout.head
sudo docker ps --format '{{.Names}} {{.Status}}' | sudo tee /root/anchor-backup-$SNAP/docker.ps
cat /var/lib/homecloud-update/status/installed.json | sudo tee /root/anchor-backup-$SNAP/installed.json
```

## 3. Заменить root-якоря из коммита батча

Якоря ставятся из git-blob'ов коммита батча — не из рабочего дерева и не с
ручной правкой. Меняются только якоря файлов, вошедших в батч; остальные —
проверить по хэшу и не трогать.

```bash
sudo git -C /home/hs/homecloud-test fetch --no-tags origin test
BATCH=$(sudo git -C /home/hs/homecloud-test rev-parse refs/remotes/origin/test)
echo "Базовый коммит перехода: $BATCH"

install_from_git () {  # install_from_git <git-path> <target> <mode>
  sudo git -C /home/hs/homecloud-test show "$BATCH:$1" | sudo tee /root/anchor-backup-$SNAP/next-$(basename $2) >/dev/null
  sudo install -o root -g root -m "$3" /root/anchor-backup-$SNAP/next-$(basename $2) "$2"
}

install_from_git deploy/linux/update-host-verify.py       /usr/local/sbin/homecloud-update-verify   0755
install_from_git deploy/linux/update-install-bridge.py    /usr/local/sbin/homecloud-update-install  0755
install_from_git deploy/linux/update-status-archive.py    /usr/local/sbin/homecloud-update-archive  0700
install_from_git deploy/linux/update-host-discover.py     /usr/local/sbin/homecloud-update-discover 0755
install_from_git deploy/linux/update-admission.py         /usr/local/libexec/homecloud/update-admission.py 0755
# root-boundary.py в батч не входил: хэш должен совпасть с ранее записанным.
```

Контрольные точки (обязательны, каждая — до следующего шага):

```bash
# 1. Каждый якорь побайтово равен blob'у коммита батча (сверка только хэшей)
check_anchor () {  # check_anchor <git-path> <anchor-path>
  a=$(sudo sha256sum "$2" | awk '{print $1}')
  b=$(sudo git -C /home/hs/homecloud-test show "$BATCH:$1" | sha256sum | awk '{print $1}')
  if [ "$a" = "$b" ]; then echo "OK $2"; else echo "РАСХОЖДЕНИЕ $2"; exit 1; fi
}
check_anchor deploy/linux/update-host-verify.py    /usr/local/sbin/homecloud-update-verify
check_anchor deploy/linux/update-install-bridge.py /usr/local/sbin/homecloud-update-install
check_anchor deploy/linux/update-status-archive.py /usr/local/sbin/homecloud-update-archive
check_anchor deploy/linux/update-host-discover.py  /usr/local/sbin/homecloud-update-discover
check_anchor deploy/linux/update-admission.py      /usr/local/libexec/homecloud/update-admission.py

# 2. Метаданные: владелец root, без ACL, без symlinks
sudo stat -c '%U:%G %a %F %n' /usr/local/sbin/homecloud-update-verify /usr/local/sbin/homecloud-update-install \
  /usr/local/sbin/homecloud-update-archive /usr/local/sbin/homecloud-update-discover \
  /usr/local/libexec/homecloud/update-admission.py
```

## 4. Передвинуть checkout-бейзлайн

```bash
sudo git -C /home/hs/homecloud-test status --porcelain   # должно быть пусто
sudo git -C /home/hs/homecloud-test merge --ff-only refs/remotes/origin/test
sudo git -C /home/hs/homecloud-test rev-parse HEAD        # == $BATCH
```

После этого верификатор читает helper-байты из checkout, совпадающие с новыми
закреплёнными хэшами (QUALIFIED в `update-host-verify.py`), и gate
`target_sources` для кандидатов на базе `test` проходит.

Контроль: контейнеры продолжают работать на прежних пинах —
`sudo docker ps` без изменений, HTTPS отвечает.

## 5. Синтетическая проверка якорей

```bash
# Discovery: должен перепубликовать available.json новым якорем
sudo systemctl start homecloud-update-discover.service
journalctl -u homecloud-update-discover.service --since '-2 min' --no-pager
sudo cat /var/lib/homecloud-update/status/available.json   # commit == $BATCH

# Верификатор без заявки обязан отказать (fail-closed)
sudo /usr/bin/python3 -I -S /usr/local/sbin/homecloud-update-verify; echo "exit=$?"  # ожидается STOP
```

## 6. Квалификационная кампания

Полная первичная кампания — план стенда, п. 4–5. Для перехода достаточно
пяти прогонов с записью evidence в `docs/evidence/vm120-e2e/`:

1. **Успешная additive-установка кандидата через UI** — главный прогон 31→34
   (или эквивалент на свежем кандидате): фазы CHECKOUT…COMPLETE на новых
   helper'ах, обязательный `MIGRATION_APPLY` после `BACKUP` и до
   `START_SERVICES`, включая вылеченные дискриминаторы (backup-fence в
   TEST-ветке при `homecloud-e2e-120`; restart-identity по runtime-имени
   проекта). Записать backup_id из last-status.json и applied-набор, точно
   равный манифесту.

   В момент перехода UI/API-инициирование недоступно: backend-гейт требует
   `sourceGitSha == installed.gitSha`, а после ff-merge (шаг 4) они
   расходятся до первой установки. Заявку подаём записью в inbox
   (байт-в-байт формат, который пишет backend): файл
   `/var/lib/homecloud-update/inbox/request.json`, владелец `1001:65533`,
   mode 0600, атомарно через tmp + hardlink; затем
   `systemctl start homecloud-update-admission.service`. В штатном потоке
   (installed == checkout HEAD) пользовательский путь через UI работает
   без изменений. Внимание: заявка с commit, равным installed, получит от
   установщика `SKIP` и будет отклонена мостом как ambiguous — для
   drill'ов нужен кандидат с новым коммитом.
2. **Отказ до бэкапа**: заявка с несуществующим `manifestSha256` →
   статус STOP, `pending.json` отсутствует, данные и контейнеры не тронуты.
3. **Потерянное подтверждение**: SIGKILL установщика после фазы BACKUP →
   статус MANUAL_RECOVERY_REQUIRED, журнал указывает на backup_id,
   восстановление по recovery-inspect завершается сравнением данных.
4. **Неприменимая новая миграция**: отдельно проверенный disposable-кандидат
   с заведомо failing up-миграцией → отказ в `MIGRATION_APPLY`, статус
   MANUAL_RECOVERY_REQUIRED, `pending.json` и backup_id сохранены, полный
   `START_SERVICES` не выполнен, повторный apply заблокирован. Восстановление
   только из backup; down-миграция запрещена.
5. **SIGKILL в миграционной фазе**: завершить установщик после записи
   `MIGRATION_APPLY` → MANUAL_RECOVERY_REQUIRED по pending/recovery-inspect,
   повторный apply заблокирован до operator reconciliation; затем выполнить
   восстановление из backup и сравнить схему и данные.

Каждый прогон: зафиксировать phase/pending/last-status, список контейнеров,
миграции, контрольные суммы данных (по регламенту плана стенда).

## 7. Пост-проверки успешной установки

- 4 контейнера healthy; публичный HTTPS отвечает 200.
- `installed.json`: `gitSha == $BATCH` (или новее); applied-миграции,
  `state.json`, `installed.json` и манифест содержат один и тот же целевой набор.
- `last-status.json`: status INSTALLED, backup_id записан.
- Discovery: кандидат «current» (commit == HEAD == installed).

## 8. Переименование репозитория (после зелёного состояния)

Код батча dual-name: helper'ы и бэкенд работают с любым именем
(основное `sv3t0v1k/homecloud`, запасное — прежнее). Переименование
безопасно в любой момент после шага 7.

```bash
gh repo rename homecloud        # требуется scope delete_repo; имя свободно
```

Проверки после rename (≤ 6 минут, таймер discovery):
- `curl -s -o /dev/null -w '%{http_code}' https://api.github.com/repos/sv3t0v1k/homecloud` → 200.
- Discovery на vm120 перепубликовал available.json (journalctl).
- В UI «Проверить снова» — канал test отвечает, версии совпадают.
- CI: триггерный прогон (мелкий docs-PR) зелёный.

GHCR: ранее опубликованные образы остаются по прежнему пути и продолжают
pull'иться; новые сборки пойдут под `ghcr.io/sv3t0v1k/homecloud/*` —
проверки дайджестов умеют оба имени.

## 9. Закрытие окна

```bash
sudo systemctl disable --now homecloud-update-admission.path
```

Финальный отчёт владельцу: исходное/конечное состояние (checkout.head,
anchors.sha256 до/после), результаты кампании, решения по замечаниям.

## Приложение. Точки отката

- **До шага 6**: вернуть якоря из `/root/anchor-backup-$SNAP/` и
  `git -C /home/hs/homecloud-test reset --hard <старый HEAD>`.
- **После успешной установки (шаг 7)**: откат версии приложения только через
  восстановление из записанного `backup_id` (recovery-inspect), не через git.
- **После rename**: обратное переименование репозитория возможно в любой
  момент (код работает с обоими именами).
