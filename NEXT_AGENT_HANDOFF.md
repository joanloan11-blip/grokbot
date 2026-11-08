# Передача следующему агенту: «Маяк» (QASTOM Agent) на qastom

Файл написан 2026-11-07 после сессии эксплуатации. Читать целиком до любых правок.
Дополнение к [CODEX_HANDOFF.md](CODEX_HANDOFF.md) — там история разработки, здесь состояние
инфраструктуры и грабли, на которые уже наступили.

---

## 1. Где что лежит

| Что | Где |
|---|---|
| Прод-сервер | `rus@217.197.114.108`, hostname `qastom`, Ubuntu 26.04.1, 4 vCPU, 7.2 GiB |
| Репозиторий | `/opt/mayak`, рабочее дерево чистое; актуальный коммит — `git log -1` |
| Публичный вход | `https://app.geminibot.ru` → nginx → `127.0.0.1:8090` → контейнер `mayak-app-1:8787` |
| Данные | том `mayak_data` → `/app/data` (SQLite `mayak.sqlite` + `-wal` + `-shm`, `skills/`, `uploads/`, `debug/`) |
| Второй сервер | `root@222.167.226.61`, hostname `vds.1185` — там живёт LLM-relay и чужие проекты |
| Резервные копии конфигов | `/home/rus/backups/mayak-config-20261107-0831/` и `...-0849/` (700/600) |
| Бэкапы | `/home/rus/backups/`: `backup-all.sh` по cron в 03:30, артефакты в `db/`, GPG + Google Drive |
| Восстановление из бэкапа | [RESTORE-MAYAK.md](RESTORE-MAYAK.md) |

Docker 29.1.3, Compose 2.40.3, Node в контейнере 22.23.4. `mayak-app` собран из этого же
каталога (`Dockerfile`, pnpm + esbuild).

**Пользователей на проде двое и они реальные** (admin и manager). Любая правка — это чужой
рабочий инструмент, а не песочница.

---

## 1.1 Что нового 2026-11-08: почта и Telegram

- Добавлены личные каналы: «Почтовый агент» (IMAP, ежедневная выжимка рутиной «Утренняя почта»)
  и «Джарвис» (личный Telegram-бот по токену и ID). Настройки — в приложении, вкладки «Почта»
  и «Telegram»; секреты шифруются JWT_SECRET.
- Стартовые агенты создаются при регистрации и досоздаются при старте сервера
  (`ensureStarterAgents`), поэтому после обновления они появились у обоих пользователей.
- ВАЖНО: на qastom был мёртв провайдерский DNS (systemd-resolved → 217.174.96.14). В
  `docker-compose.qastom.yml` сервисам `app` и `egress` прописаны `dns: [1.1.1.1, 77.88.8.8]`.
  Если снова перестанут открываться внешние адреса из контейнера — проверяйте сначала DNS.
- Образ 2026-11-08 собран overlay-способом (базовый образ + dist), откат —
  `mayak-app:before-mail-telegram`. Подробности — в CODEX_HANDOFF.md.

## 2. Что сделано 2026-11-07 (моя сессия)

| Коммит | Содержание |
|---|---|
| `0bb2ec0` | Закоммичено 36 файлов незакоммиченной работы Codex (агенты, каталог возможностей, личные коннекторы) + журналы + `docker-compose.qastom.yml` + 12 SKILL.md |
| `873acfd` | Журнал: чистка диска, amoCRM, журнал сбоев, git-гигиена |
| `b4146ba` | LLM-relay: SOCKS5 через SSH на `steerflow-vps` вместо внешнего прокси |

### 2.1 LLM-relay (главное изменение)

Было: `LLM_PROXY_URL=http://user:pass@187.13.88.241:63470` — внешний HTTP-прокси, который
**обрывает тела от ~30 КБ**. Измерено: 16 КБ проходит, 32 и 48 КБ — таймаут. Из-за этого
`fitBody()` ужимал историю до 16 КБ (результаты инструментов — до 250–1500 символов), а часть
ходов падала после выполнения инструментов.

Стало:

```
mayak-app-1 --socks5--> mayak-llm-relay --ssh--> vds.1185 --> api.openai.com
            (mayak_default)   (alpine + ssh)      222.167.226.61
```

- Исходники: `deploy/qastom-relay/` (Dockerfile, entrypoint.sh, docker-compose.yml, README).
- Контейнер `mayak-llm-relay`, сеть `mayak_default`, **портов наружу нет**, 64 МБ, restart unless-stopped.
- Ключ `/home/rus/.ssh/mayak-relay` (ed25519), в контейнере только на чтение.
- На `vds.1185` в `/root/.ssh/authorized_keys` строка ограничена
  `from="217.197.114.108,217.197.114.115",no-pty,no-agent-forwarding,no-X11-forwarding`.
- В `.env`: `LLM_PROXY_URL=socks5://llm-relay:1080`, `LLM_PROXY_MAX_BODY=200000`.
- Откат: вернуть значение из `/home/rus/backups/mayak-config-20261107-0849/.env.before-relay`,
  убрать `LLM_PROXY_MAX_BODY`, затем `docker compose -p mayak -f docker-compose.qastom.yml up -d app`.

Проверено: тела 4/40/**120 КБ** до `api.openai.com` дают `401` за 0.7–1.0 с; `check-models`
провайдеров 233 и DeepSeek — все модели отвечают; relay переживает `kill 1` (restart, healthy).

### 2.2 Логи сбоев

Три правки, закрывающие слепую зону (раньше в `docker logs mayak-app-1` было **три строки за всё время**):

- `apps/server/src/app.ts` — ошибка хода пишется в журнал: `[turn] чат <id> · <модель> · <текст>`.
- `apps/server/src/providers/http.ts`, `dumpFailed()` — сообщает размер тела, превышение лимита
  прокси и был ли прокси вообще.
- `apps/server/src/providers/http.ts`, `fitBody()` — обёртка пишет в журнал факт обрезки истории.

### 2.3 amoCRM

Коннектор отдавал `404`: в `mcp_servers.url` лежал путь без `/mcp` и с устаревшим секретом.
Актуальный вид: `http://amocrm-mcp:8765/<MCP_SECRET>/mcp`, секрет — в
`/home/rus/amocrm-mcp-deploy/.env` (в репозиторий и журнал не писать). Проверка: `initialize` → 200,
`serverInfo.name = amoCrm MCP Server`. Если снова 404 — секрет пересоздали, повторить сверку.

### 2.4 Диск и git

- `docker builder prune -af` (дважды) + удаление 5 устаревших rollback-образов: 84% → **71%**
  (свободно 16 ГБ). Образы чужих проектов не трогались.
- `.env.bak.*` и `docker-compose.qastom.yml.bak-*` вынесены из репозитория в
  `/home/rus/backups/mayak-config-20261107-0831/`, в `.gitignore` добавлены `*.bak`, `*.bak-*`,
  `.env.*` (с исключением `.env.example`).

### 2.5 Мелкие правки

- Агент «Ассистент» переведён с несуществующей `gpt-5.2-chat-latest` на `gpt-5.4-mini` — ту модель,
  на которой он и так работал из-за молчаливого отката. Состояние до правки:
  `/home/rus/backups/agent-assistant-before-*.json`.
- Сервис `xray` удалён из `docker-compose.qastom.yml` (контейнер снят через `--remove-orphans`).
  Конфиг `/home/rus/xray/config.json` и образ на диске не тронуты.

---

## 3. Текущее состояние (проверено)

12 контейнеров с именем `mayak*`, все Up, `RestartCount=0`:

```
mayak-app-1, mayak-llm-relay, mayak-runner-1, mayak-egress-1,
mayak-mcp-{moysklad,browser}-1, mayak-mcp-avito-{main,ekat,account2,borodach,
perviy-rulevoy,qastom-chelyaba}-1
```

- `/api/health` → 200 локально и снаружи, `{"ok":true,"name":"mayak","version":"0.1.0","auth":true}`.
- Наружу открыты только 22, 80, 443. `8090` — на loopback.
- Образы: `mayak-app:latest` = `018feee63746` (в работе), `mayak-app:before-agent-name-scope` = `b3ccbf3e33ba`.
- Данные на момент передачи: 2 пользователя, 9 агентов, 43 чата, 470 сообщений, 268 вызовов LLM,
  6 провайдеров, 9 MCP-серверов.

---

## 4. Как проверить, что всё живо

```bash
# здоровье
curl -s http://127.0.0.1:8090/api/health
curl -s -o /dev/null -w '%{http_code}\n' https://app.geminibot.ru/api/health

# контейнеры и рестарты
docker ps --filter name=mayak --format '{{.Names}}\t{{.Status}}'
for c in $(docker ps -aq --filter name=mayak); do
  echo "$(docker inspect -f '{{.Name}}' $c) $(docker inspect -f '{{.RestartCount}}' $c)"; done

# relay
docker inspect -f '{{.State.Health.Status}}' mayak-llm-relay
docker logs --tail 5 mayak-llm-relay

# провайдеры (живой запрос к каждой модели провайдера)
docker exec -w /app mayak-app-1 node apps/server/dist/index.js check-models DeepSeek
docker exec -w /app mayak-app-1 node apps/server/dist/index.js check-models 233

# журнал приложения (после правок 2.2 здесь будут видны сбои)
docker logs --since 30m mayak-app-1 | grep -E '\[turn\]|\[llm\]'
```

Проверка тела большого запроса (то, ради чего делался relay) — из контейнера приложения,
SOCKS5 вручную на `llm-relay:1080`, `CONNECT api.openai.com:443`, POST с телом 40–120 КБ.
Ожидаемо: `HTTP/1.1 401` за ~1 с (значит запрос дошёл; ключа в тесте нет намеренно).

### Бэкапы

```bash
ls -lat ~/backups/db | head -5        # что уже создано и когда
tail -5 ~/backups/backup.log          # итог последнего ночного прогона

~/backups/backup-all.sh               # внеплановый бэкап: БД, Маяк, конфиги, git
~/backups/restore-check-mayak.sh      # проверка восстановления Маяка из Drive
```

Ежедневно в 03:30 cron запускает `backup-all.sh`: дампы PostgreSQL всех проектов и `mayak_data`
(снимок SQLite через `VACUUM INTO`), `mayak_conf` (`.env` + compose), `mayak_git` (bundle).
Всё шифруется GPG AES-256 и уходит в `drive:qastom-backups`; локально 14 дней, в Drive 30.
Пошаговое восстановление — [RESTORE-MAYAK.md](RESTORE-MAYAK.md).

---

## 5. Грабли (читать до правок)

1. **Исходящий IP qastom — `217.197.114.115`, а не `.108`.** Первый запуск relay упал на
   `from="217.197.114.108"`, а fail2ban на `vds.1185` забанил адрес. В `authorized_keys`
   прописаны оба IP; при смене адреса туннель перестанет подниматься именно с этой ошибкой.
2. **fail2ban на `vds.1185` активен** (тысячи банов). Любые парольные попытки по SSH оттуда
   прилетают баном. В relay принудительно `PreferredAuthentications publickey`,
   `PasswordAuthentication no` — не убирать. Разбан: `fail2ban-client set sshd unbanip <IP>`.
3. **esbuild экранирует кириллицу в `dist/index.js` в `\uXXXX`.** `grep 'часть истории'` по бандлу
   даёт ноль при рабочем коде. Проверять через Node (`indexOf` по строке) или по ASCII-маркерам
   (`fitBodyInner`, `[turn]`, `[llm]`).
4. **`rsync -R/--relative` с несколькими источниками создаёт вложенные каталоги** в приёмнике
   (я так получил `/opt/mayak/apps/server/src/apps/server/src/app.ts`). Передавать файл,
   указывая полный целевой путь: `rsync файл host:/opt/mayak/путь/файл`.
5. **`docker tag` по короткому ID** требует ровно `docker tag <id> repo:tag`; конструкция
   `docker tag 9d1a4fe0d427 mayak-app:before-logging` даёт ошибку `No such image: ...:latest`.
6. **Образ, работавший до моей пересборки (`9d1a4fe0d427`), не сохранён** — тег поставить не
   успел, имя перезаписала сборка. Готовый откат только на `mayak-app:before-agent-name-scope`
   (состояние на два деплоя раньше). Точный откат — из git, см. §6.
7. **Приложение не логирует HTTP-запросы.** В журнале: старт, предупреждения `[turn]`/`[llm]`,
   и всё. Не искать в логах «кто делал запрос» — там этого нет.
8. **`LLM_PROXY_MAX_BODY` привязан к транспорту.** Со своим relay лимита нет, 200000 безопасно.
   Если вернуть внешний HTTP-прокси — ставить обратно 16000, иначе тела ≥30 КБ будут висеть
   до таймаута (90 с на заголовки + повтор → ~107 с на вызов).
9. **`node:sqlite` в Node 22 ещё экспериментальный** (в логах предупреждение — нормально).
   Копировать БД только вместе с `-wal` и `-shm`, иначе увидите устаревшие данные.
10. **Сборка образа**: `docker compose -p mayak -f docker-compose.qastom.yml build app` — несколько
    минут, затем `up -d --no-deps app`; приложение недоступно 5–10 с. Собирать **до** перезапуска,
    старый контейнер при неудачной сборке продолжает работать.
11. **Сервер общий.** Тут же живут `bible-finance`, `salesmind`, `avito-platform`, `searxng`,
    `whisper`, MCP-серверы. `docker system prune -a` и `docker image prune -a` удалят чужие образы
    и rollback-теги — только адресные `docker rmi`/`builder prune`.
12. **Секреты.** `.env` не в git (закрыт `.gitignore`). Токены MCP лежат в БД в `mcp_servers.headers_json`,
    ключ amoCRM — в `.env` его контейнера, ключи провайдеров — в `providers.api_key` (зашифрованы
    `JWT_SECRET`). Не печатать значения в чат и коммиты; в отчётах маскировать.
13. **Xray удалён из compose (2026-11-07).** `mayak-xray-1` больше не поднимается, его роль
    выполняет `deploy/qastom-relay`. Он был мёртвым: SOCKS5 принимал CONNECT, но TLS до
    `api.openai.com` рвался с `ECONNRESET` (~82 с). Конфиг `/home/rus/xray/config.json` и образ
    на диске остались — если решите вернуть VLESS, сервис надо добавлять заново.
14. **`check-models` пишет в `model_caps`** — это штатное поведение (приложение само это делает
    периодически), не считать побочным эффектом.
15. **`docker compose` в `/opt/mayak` всегда с `-p mayak -f docker-compose.qastom.yml`.** Голый
    `docker compose up` поднимет базовый `docker-compose.yml` с другим набором сервисов и сломает прод.

---

## 6. Как откатывать

| Что | Как |
|---|---|
| Только транспорт LLM | Вернуть `.env` из `/home/rus/backups/mayak-config-20261107-0849/.env.before-relay`, убрать `LLM_PROXY_MAX_BODY`, `up -d app` |
| Код к состоянию до моих правок логов | `git revert 0bb2ec0^..b4146ba --no-commit` не подходит (там же чужая работа); точечно: взять `apps/server/src/app.ts` и `providers/http.ts` из коммита `2083749`, пересобрать |
| Всё приложение на предыдущий образ | `docker tag mayak-app:before-agent-name-scope mayak-app:latest` + `up -d --no-deps app` (потеряются правки агентов/каталога — они моложе) |
| Relay | `docker compose -p mayak-relay down` (в каталоге `deploy/qastom-relay`); приложение сразу перестанет ходить в OpenAI |
| amoCRM | Вернуть прежний URL из журнала нельзя (там секрет не записан) — при откате коннектор будет 404, лучше оставить как есть |
| База | Восстановление из `~/backups/db/mayak_data_*.tar.gz` — см. [RESTORE-MAYAK.md](RESTORE-MAYAK.md). Папка `/home/rus/backups/mayak/` — устаревший формат (03.11), не использовать |

---

## 7. Открытые задачи

1. **Проверить end-to-end чат под пользователем.** Я не входил под владельцем, поэтому весь
   пользовательский путь (вход → чат → инструменты → ответ) после переключения на relay
   проверен только на уровне провайдера. Это первое, что стоит сделать.
2. **20% вызовов LLM с нулевым выходом** (55 из 268 на момент анализа) и **5 из 25 последних
   чатов заканчивались сообщением `tool` без ответа**. Причина не доказана: часть — сетевые
   обрывы старого прокси (3 дампа в `/app/data/debug`, тела 35–44 КБ, таймаут 90 с), часть —
   не установлена. Теперь каждый такой случай пишется строкой `[turn]`, смотреть после первых суток.
3. **Бэкапы работают, но проверка восстановления была только для Bible Finance.** Добавлен
   `~/backups/restore-check-mayak.sh` (вызывается из `restore-check.sh` по воскресеньям 05:15):
   качает свежий `mayak_data` из Drive, расшифровывает, проверяет `integrity_check` и строки.
   Первый прогон прошёл: users=2, agents=9, chats=43, messages=470. Осталось убедиться, что
   уведомление об ошибке реально доходит (вручную сломать проверку нельзя — только ждать сбоя).
4. **Telegram не настроен**: 0 привязок, токена нет (`telegram_links` пуста). Код есть.
5. **ЮKassa выключена** (`enabled:false`, 0 платежей, 0 кошельков). Тарифы 990/2990 ₽ отдаются
   публично через `/api/public/plans`. Никогда не прогонялось вживую.
6. **`projects` и `pages` пусты** — фичи есть, но не используются; возможно, стоит скрыть из UI.
7. **Модель агента «Ассистент» исправлена** (2026-11-07): было `gpt-5.2-chat-latest`, которой нет
   у провайдера `233`, и `runTurn` молча подставлял `gpt-5.4-mini`. Теперь в БД та же модель,
   что реально работала. Если владельцу нужно качественнее — `gpt-5.5` у того же провайдера
   проверен и отвечает: менять через UI агента.
8. **Xray** — удалён из `docker-compose.qastom.yml`, контейнер снят. Возврат VLESS — см. §5 п.13.
9. **Диск 71%** (16 ГБ свободно). Растёт от сборок: после каждой — `docker builder prune -af`.

---

## 8. Правила работы

- Любую правку заканчивать записью в [CODEX_HANDOFF.md](CODEX_HANDOFF.md) с датой по
  Asia/Yekaterinburg: задача, файлы, проверки, коммит. Без секретов.
- Перед правками — `git status` и `git log`: на сервере мог работать другой исполнитель,
  а владелец правит прямо из браузера.
- Проверка после выката обязательна: `/api/health` → 200, `RestartCount` = 0, публичный HTTPS → 200,
  и хотя бы один живой `check-models`.
- Не менять `.env`, compose и БД «заодно»: каждое изменение — отдельно и с бэкапом в
  `/home/rus/backups/`.
- Сомневаешься в действии на проде — спроси владельца. Это его рабочий инструмент, не тестовая среда.
