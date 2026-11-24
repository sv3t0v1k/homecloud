# Доверенный переход VM120 на 84fd07d: TEST-самообслуживание и reuse CI — 2026-11-24

Стенд: vm120 (`homecloud-e2e`, `ubuntu@192.168.3.117`), checkout `/home/hs/homecloud-test`,
compose-проект `homecloud-e2e-120`. Владелец: Alex. Оператор: агент по согласию владельца.

## Цель и результат

Перевести TEST-стенд с доверенного базового уровня `423bdf7abe24b7959c6d346c04e4522236d9e07b`
на защищённый `origin/test` `84fd07db57cb36ab4cb5383e28484e37352a6114`
(merge PR #89; история включения включает PR #85–#89) и квалифицировать установку нового
канала. **Результат: INSTALLED**, trusted transition закрыт, production RELEASE не заявляется.

Целевой кандидат: CI run `45334128235`, artifactId `14893351118`,
manifest `26a9e47ad89c0464f0f314e65549eb6a5b7731e93fe28f1441e7b4e2ddbdbcae`,
35 миграций.

## Контекст перехода

- Для root anchors критичны helper-изменения диапазона `423bdf7..84fd07d`:
  `deploy/linux/test-channel.py`, `deploy/linux/update-host-verify.py`,
  `deploy/linux/update-install-bridge.py`, `deploy/linux/update-status-archive.py`
  и связанные CI scripts.
- Полный кандидат дополнительно содержит пользовательские frontend/docs-изменения
  PR #85–#89; operational/Compose lock в диапазоне не менялся.
- Старая заявка в inbox от вчерашней попытки обновления через UI была сохранена как
  `/root/anchor-backup-20261124T082240Z/stale-ui-request.json`; она ссылалась на
  `manifestSha256=a564df476f1a6cfc86772a13e83879ad39ad48498d3b6f34dc77f1121a9b1171`
  **не использовалась**.
- Перед окном владелец подтвердил доступ к VM120 и разрешил продолжить trusted transition.

## Предусловия (проверены)

- `pending.json` отсутствовал; 4 контейнера healthy; SSH/sudo работали.
- installed и checkout совпадали с `423bdf7`.
- Доверенный diff helper/CI-части был ограничен helper-файлами и CI scripts;
  operational Compose lock не изменялся.
- Защищённый `origin/test` указывал на `84fd07d`.

## Шаг 2: бэкап (2026-11-24T08:22:40Z)

Snapshot: `/root/anchor-backup-20261124T082240Z/`.

Сохранены до изменений: шесть root anchors, `anchors.before.sha256`,
`checkout.head.before`, `checkout.status.before`, `docker.ps.before`,
`installed.before.json`, `last-status.before.json`, `data.before.txt`,
 checkout-refs helper-байтов и старая UI-заявка.

## Шаг 3: root anchors (08:24–08:29Z)

Из git-blob'ов `84fd07d` заменены только:

- `/usr/local/sbin/homecloud-update-verify`;
- `/usr/local/sbin/homecloud-update-install` (`root:root`, mode 0755);
- `/usr/local/sbin/homecloud-update-archive` (`root:root`, mode 0700).

После замены все шесть anchors побайтово совпали с `84fd07d`:

```text
2bcc7cb82339505eebeb3d4d864c9a64f4f8794feea448956c9f7c3355f5677d  /usr/local/sbin/homecloud-update-verify
d989f7525c74530b776088fdc23aec245da49744349021fc159dd4c87ee8fbd5  /usr/local/sbin/homecloud-update-install
47ab8164e94eff14e1a462c9163f3335eb10da456e0427684449802a87dc9c36  /usr/local/sbin/homecloud-update-archive
a8045949fd325bd46d4bd556b4789137c2dad8afe0335878056caa7771dba48f  /usr/local/sbin/homecloud-update-discover
51cda835a4bbbd16f2821404e75e920aa8240a86c2bbcbeddce0eaf803b2f1f2  /usr/local/libexec/homecloud/update-admission.py
f8199f84ff581cd34c27e20f29fc06398986de7b8722dcef10954c01526b8903  /usr/local/sbin/homecloud-test-launcher
```

## Шаг 4: бейзлайн checkout

Checkout fast-forwarded `423bdf7 → 84fd07d`, дерево чистое. Контейнеры не пересоздавались
на этом шаге и продолжали работать.

## Шаг 5: синтетика

- Discovery опубликовал `available.json` на `84fd07d`, `sourceGitSha=423bdf7`,
  run `45334128235`, artifactId `14893351118`, 35 миграций.
- Повторный discovery успешен.
- Verifier без заявки завершился fail-closed: `exit=1`,
  `STOP: host evidence verification refused; operator review required`.
- HTTPS 200, контейнеры healthy, checkout clean.

## Шаг 6: квалификационная установка (08:31–08:32Z)

- В inbox атомарно подана актуальная заявка `homecloud-update-request-v1`
  с `manifestSha256=26a9e47a…`; старая UI-заявка не использовалась.
- Admission/install прошли успешно. Receipt:
  `/var/lib/homecloud-update/status/archive/26a9e47ad89c0464f0f314e65549eb6a5b7731e93fe28f1441e7b4e2ddbdbcae.json`.

```json
{"format":"homecloud-update-status-v1","manifestSha256":"26a9e47ad89c0464f0f314e65549eb6a5b7731e93fe28f1441e7b4e2ddbdbcae","phase":"COMPLETE","status":"INSTALLED","updatedAt":"2026-11-24T08:32:42.854151+00:00"}
```

- backup_id `20261124_083158_275f3719`.
- `installed.json`: `gitSha=84fd07db57cb36ab4cb5383e28484e37352a6114`,
  `version=84fd07d`, 35 миграций.
- Пост-install discovery показал `commit == sourceGitSha == 84fd07d`.
- Новый archive-helper переместил receipt в `status/archive` и удалил `current.json`;
  это ожидаемое новое поведение, не сбой установки.

## Сверка данных

Backup БД разобран без обрыва pipe; `data.backup-counts.txt` в snapshot содержит точные
COPY-counts. На финальной сверке все не-сессионные таблицы совпали:

```text
MATCH archive_download_capabilities|0
MATCH download_capabilities|0
MATCH file_copy_admission|1
MATCH file_copy_operations|0
MATCH files|6
MATCH folders|2
MATCH migrations|35
MATCH public_share_operations|0
MATCH share_links|1
MATCH ssd_finalization_chunks|0
MATCH ssd_finalization_operations|0
MATCH storage_locations|1
MATCH upload_chunks|0
MATCH upload_sessions|4
MATCH upload_workspaces|2
MATCH user_deletion_operations|0
MATCH users|2
```

`refresh_tokens`: backup содержал 182 строки; на момент финального evidence накоплен
runtime churn до 188 строк. Безопасные метаданные без хэшей сохранены в snapshot:
`data.refresh-token-safe-metadata.backup.txt` и `data.refresh-token-safe-metadata.after.txt`.
Наблюдаемая последовательность — штатная ротация/отзыв refresh-сессий после backup,
а не потеря пользовательских данных.

## Финальное состояние

- checkout `84fd07d`, installed `84fd07d`, candidate «current».
- Discovery timer `enabled/active`; `homecloud-update-admission.path disabled/inactive`.
- `AUTO_UPDATE=false`; inbox пуст; `pending.json` отсутствует.
- 4 контейнера healthy; `https://192.168.3.117:18443/` → 200.
- Старый скрытый `.request-op.tmp` от 2026-11-22 сохранён как
  `inbox.stale-request-op.tmp.json` и удалён из inbox после фиксации evidence.
- Полный VM-snapshot: `/root/anchor-backup-20261124T082240Z/`.

## Точки отката

- До установки: root anchors из snapshot + `git reset --hard 423bdf7`.
- После установки: только через backup_id `20261124_083158_275f3719`
  и штатную recovery-процедуру.

## Граница

Это qualification TEST-канала VM120. Production RELEASE — **NO_GO**.
