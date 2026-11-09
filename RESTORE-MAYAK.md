# Восстановление «Маяка» из бэкапа

Как поднять QASTOM Agent (geminibot.ru) с нуля или откатить данные на вчерашний день.
Бэкап делает `~/backups/backup-all.sh` ежедневно в 03:30 (cron пользователя `rus`).

## Что лежит в бэкапе

| Файл | Содержимое | Куда кладётся |
|---|---|---|
| `mayak_data_<TS>.tar.gz` | снимок SQLite (`mayak-snap.sqlite`, сделан через `VACUUM INTO` — консистентный), `skills/`, `uploads/`, `workspaces/`, `debug/` | том `mayak_data:/app/data` |
| `mayak_conf_<TS>.tar.gz` | `.env` и `docker-compose.qastom.yml` | `/opt/mayak/` |
| `mayak_git_<TS>.bundle` | полная git-история репозитория | `/opt/mayak/.git` |

Всё шифруется GPG (AES-256) и уходит в `drive:qastom-backups`. Ключ — `~/backups/.backup-passphrase`,
копия пароля должна храниться **вне сервера**. Локально: 14 дней, в Drive: 30 дней.

---

## 0. Где ещё лежат копии (обновлено 2026-11-09)

- **Google Drive** `drive:qastom-backups` — основная offsite-копия (30 дней). Проверено:
  `restore-check-mayak.sh` скачивает и восстанавливает снимок (integrity=ok).
- **Второй сервер vds.1185** (`root@222.167.226.61`, `/root/qastom-backups`) — вторая копия
  с другого ЦОД: те же зашифрованные файлы (14 дней) + `.backup-passphrase`, `rclone.conf.qastom`,
  `mayak-dump.sh` и этот файл. Копия кладётся каждую ночь из `~/backups/backup-all.sh`.
- **Аварийный стенд** на том же vds: `/root/mayak-standby/` — собранный образ, репозиторий,
  боевой `.env`, восстановленный том и `/root/mayak-standby/RUNBOOK.md` с шагами переключения
  (DNS, nginx, certbot, ограничения стенда). Проверено: приложение поднимается, health 200,
  данные на месте (users=2, agents=16, messages=1147).
- ВАЖНО: файл `.backup-passphrase` теперь есть на обоих серверах, но по-прежнему должен быть
  продублирован в менеджер паролей вне серверов. Если меняете пароль — обновите обе копии и Drive.

---

## 1. Достать и расшифровать

```bash
# с сервера, где настроен rclone:
rclone lsf drive:qastom-backups --include "mayak_*" | sort | tail -3
mkdir -p /tmp/mayak-restore && cd /tmp/mayak-restore
rclone copy drive:qastom-backups/mayak_data_2026-11-07_1318.tar.gz.gpg .
rclone copy drive:qastom-backups/mayak_conf_2026-11-07_1318.tar.gz.gpg .

gpg --batch --pinentry-mode loopback --passphrase-file ~/backups/.backup-passphrase \
    -d -o mayak_data.tar.gz mayak_data_2026-11-07_1318.tar.gz.gpg
gpg --batch --pinentry-mode loopback --passphrase-file ~/backups/.backup-passphrase \
    -d -o mayak_conf.tar.gz mayak_conf_2026-11-07_1318.tar.gz.gpg
```

## 2. Код

```bash
git clone <origin> /opt/mayak && cd /opt/mayak
# либо из бандла:
git clone mayak_git_2026-11-07_1318.bundle /opt/mayak
```

## 3. Конфиг

```bash
tar xzf /tmp/mayak-restore/mayak_conf.tar.gz -C /opt/mayak
chmod 600 /opt/mayak/.env
```

Проверить в `.env`: `LLM_PROXY_URL` указывает на `socks5://llm-relay:1080`. Если relay не
восстановлен, LLM работать не будет — см. `deploy/qastom-relay/README.md` (ключ
`/home/rus/.ssh/mayak-relay` и разрешение на второй сервер нужны отдельно).

## 4. Данные в том

`mayak-snap.sqlite` — это **снимок**, его надо положить как боевую базу:

```bash
mkdir -p /tmp/mayak-restore/data && tar xzf /tmp/mayak-restore/mayak_data.tar.gz -C /tmp/mayak-restore/data
docker volume create mayak_data
docker run --rm -v mayak_data:/target -v /tmp/mayak-restore/data:/src alpine sh -c '
  cp -a /src/. /target/ &&
  cd /target &&
  mv mayak-snap.sqlite mayak.sqlite &&
  rm -f mayak.sqlite-wal mayak.sqlite-shm'
```

## 5. Поднять

```bash
cd /opt/mayak
docker compose -p mayak -f docker-compose.qastom.yml up -d --build
curl -s http://127.0.0.1:8090/api/health
```

Обязательно `-p mayak -f docker-compose.qastom.yml`: голый `docker compose up` поднимет другой
набор сервисов.

## 6. Проверить, что данные на месте

```bash
docker exec mayak-app-1 node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/app/data/mayak.sqlite');
for (const t of ['users','agents','conversations','messages','mcp_servers'])
  console.log(t, db.prepare('select count(*) c from '+t).get().c);
"
```

Ориентир на 2026-11-07: users 2, agents 9, conversations 43, messages 470, mcp_servers 9.

## 7. Автоматическая проверка

`~/backups/restore-check.sh` (воскресенье 05:15) проверяет восстановление Bible Finance и
вызывает `~/backups/restore-check-mayak.sh`: скачивает свежий `mayak_data` из Drive,
расшифровывает, распаковывает, гоняет `PRAGMA integrity_check` и считает строки. При ошибке
приходит уведомление через `notify.py`.

Ручной прогон:

```bash
~/backups/restore-check-mayak.sh
# ожидаемо: OK restore mayak_data_...: users=2 agents=9 chats=43 messages=470 integrity=ok
```

## Частые ловушки

- **Снимок называется `mayak-snap.sqlite`**, а не `mayak.sqlite`. Если просто распаковать архив
  в том, приложение не увидит базу и создаст пустую.
- **Удалять `mayak.sqlite-wal` и `-shm`** после подмены базы обязательно: старый WAL от другой
  базы даст порчу или пустые таблицы.
- **`mayak_mcp`, `mayak_browser`, `qastom-search_default`, `server_default`** — внешние сети,
  которые compose ожидает увидеть. Без MCP-контейнеров приложение поднимется, но коннекторы
  (amoCRM, МойСклад, Авито, браузер) будут недоступны; поиск сломается без `qastom-search_default`.
- Права на `/app/data` внутри тома — пользователь контейнера (root): после ручного копирования
  проверьте, что приложение может писать.
