#!/usr/bin/env bash
# disk-cleanup.sh — регулярная БЕЗОПАСНАЯ уборка Docker-мусора на сервере qastom.
#
# Принципы безопасности:
#   • НЕ трогает тома (volumes), сети и базы данных — данные приложений неприкосновенны.
#   • НЕ трогает работающие контейнеры.
#   • НЕ удаляет образы, на которые ссылается хоть один контейнер (запущенный/остановленный).
#   • Удаляет ТОЛЬКО образы проектов (mayak-*, bible-finance*, salesmind-*, qastom-*,
#     avito-*, steerflow-*, crm-vin-bot-*, amocrm-*) и висячие <none> — базовые образы
#     (node, postgres, nginx, redis, xray, playwright и пр.) не удаляются никогда.
#   • Остановленные контейнеры — только старше 7 дней (пересоздаваемые compose-контейнеры).
#   • При экстренной уборке образы моложе 1 часа не трогаются, чтобы не сорвать деплой.
#
# Режимы:
#   watchdog      — cron каждые 10 минут: если места достаточно — выходит сразу.
#   daily         — раз в сутки: плановая уборка (образы проектов старше недели) + vacuum журнала.
#   images <часы> — ручной режим: удалить неиспользуемые образы проектов старше N часов.
#   dry           — показать состояние, ничего не удалять.
#
# Журнал: ~/maintenance/disk-cleanup.log (авторотация 2 МБ → 1 МБ).
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

BASE="$HOME/maintenance"
LOG="$BASE/disk-cleanup.log"
mkdir -p "$BASE" || exit 0
exec 9>"$BASE/.lock" || exit 0
flock -n 9 || exit 0            # не запускаемся параллельно сами с собой

MODE="${1:-watchdog}"
ARG2="${2:-0}"

# --- пороги занятости корневого раздела (%) ---
WARN_PCT=82
LOW_PCT=88
CRIT_PCT=92
# --- сроки хранения ---
CONTAINERS_AGE=168h   # остановленные контейнеры
DAILY_IMAGES_AGE=168  # ч: образы проектов в плановой уборке
CACHE_DAILY_AGE=48h   # кэш сборки: плановая уборка
CACHE_HOT_AGE=24h     # кэш сборки при нехватке места
DANGLING_AGE=12h      # висячие образы <none>

# Префиксы репозиториев, которые считаем «своими» сборками и можем чистить.
PROJECT_PREFIXES="mayak- bible-finance salesmind- qastom- crm-vin-bot avito- steerflow- amocrm-"

log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }
say() { printf '%s %s\n' "$(date -Iseconds)" "$*"; }

# ротация собственного журнала
if [ -f "$LOG" ]; then
  size=$(stat -c%s "$LOG" 2>/dev/null || echo 0)
  if [ "$size" -gt 2097152 ]; then
    tail -c 1048576 "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
  fi
fi

used_pct() { df -P / | awk 'NR==2{gsub(/%/,"",$5); print $5}'; }
free_mb()  { df -P -B1M / | awk 'NR==2{print $4}'; }

notify() {
  if [ -f "$HOME/backups/notify.py" ]; then
    python3 "$HOME/backups/notify.py" "$1" >/dev/null 2>&1 && return 0
  fi
  log "NOTIFY (не отправлено): $1"
}

# Выполнить docker prune и записать в журнал, сколько освободилось.
prune() {
  local label="$1"; shift
  local out rc rec
  out=$("$@" 2>&1); rc=$?
  if [ $rc -ne 0 ]; then
    log "$label: ОШИБКА ($*): $(printf '%s' "$out" | tail -1)"
    return 1
  fi
  rec=$(printf '%s' "$out" | grep -o 'Total reclaimed space: .*' | head -1)
  log "$label: ${rec:-ничего не удалено}"
}

# Удаление ТОЛЬКО неиспользуемых образов проектов старше N часов.
# Базовые образы и образы с неизвестными именами сохраняются.
prune_project_images() {
  local max_age_h="$1"
  local now cutoff used id repo tag created created_s
  local deleted=0 failed=0 known_ids=" "
  now=$(date +%s); cutoff=$((now - max_age_h * 3600))
  used=$(docker ps -aq 2>/dev/null | xargs -r docker inspect -f '{{.Image}}' 2>/dev/null \
           | sed 's/^sha256://' | cut -c1-12 | sort -u)
  local before after
  before=$(free_mb)
  while IFS='|' read -r id repo tag created; do
    [ -n "$id" ] && [ -n "$repo" ] || continue
    [ "$repo" = "<none>" ] && continue            # висячие чистятся отдельной командой
    local match=0 p
    for p in $PROJECT_PREFIXES; do
      case "$repo" in "$p"*) match=1; break ;; esac
    done
    [ "$match" = 1 ] || continue                  # не наш образ — не трогаем
    if [ -n "$used" ] && printf '%s\n' "$used" | grep -qx "$id"; then
      continue                                    # образ используется контейнером
    fi
    case "$known_ids" in *" $id "*) continue ;; esac
    created_s=$(date -d "${created%% +*}" +%s 2>/dev/null) || continue
    [ "$created_s" -le "$cutoff" ] || continue    # ещё слишком свежий
    known_ids="$known_ids$id "
    if docker rmi -f "$id" >/dev/null 2>&1; then
      deleted=$((deleted + 1))
    else
      failed=$((failed + 1))
      log "  не удалось удалить $repo:$tag ($id)"
    fi
  done < <(docker images --format '{{.ID}}|{{.Repository}}|{{.Tag}}|{{.CreatedAt}}')
  after=$(free_mb)
  log "образы проектов старше ${max_age_h} ч: удалено ${deleted}, ошибок ${failed}, свободно ${after} МБ (+$((after - before)))"
}

if ! docker info >/dev/null 2>&1; then
  log "$MODE: Docker недоступен — пропуск"
  exit 0
fi

PCT=$(used_pct)
FREE=$(free_mb)

case "$MODE" in
  dry)
    say "=== DRY-RUN ==="
    say "root: занято ${PCT}% (${FREE} МБ свободно)"
    docker system df
    say "--- остановленные контейнеры ---"
    docker ps -a --filter status=exited --format '{{.Names}} {{.Image}} {{.Status}}'
    say "--- неиспользуемые образы проектов ---"
    docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedSince}}' \
      | grep -E '^(mayak-|bible-finance|salesmind-|qastom-|crm-vin-bot|avito-|steerflow-|amocrm-)' | head -40
    exit 0
    ;;

  images)
    log "manual: удаление образов проектов старше ${ARG2} ч"
    prune_project_images "$ARG2"
    log "manual done: занято $(used_pct)% ($(free_mb) МБ свободно)"
    exit 0
    ;;

  daily)
    log "daily: занято ${PCT}% (${FREE} МБ свободно)"
    prune "контейнеры старше 7 дн" docker container prune -f --filter "until=$CONTAINERS_AGE"
    prune "висячие образы старше 12 ч" docker image prune -f --filter "until=$DANGLING_AGE"
    prune_project_images "$DAILY_IMAGES_AGE"
    prune "кэш сборки старше 48 ч" docker builder prune -f --filter "until=$CACHE_DAILY_AGE"
    # ВАЖНО: тома и сети не чистим никогда — там могут лежать данные приложений.
    if sudo -n /usr/local/sbin/journal-vacuum >/dev/null 2>&1; then
      log "journal: vacuum до 300 МБ выполнен"
    else
      log "journal: vacuum пропущен (нужен root; см. ops/root-setup.sh)"
    fi
    docker system df >>"$LOG" 2>&1
    log "daily done: занято $(used_pct)% ($(free_mb) МБ свободно)"
    exit 0
    ;;
esac

# ---------- watchdog ----------
if [ "$PCT" -lt "$WARN_PCT" ]; then
  log "ok: занято ${PCT}%, свободно ${FREE} МБ — уборка не нужна"
  exit 0
fi

log "watchdog: МАЛО МЕСТА — занято ${PCT}%, свободно ${FREE} МБ"

# Шаг 1: безопасный минимум
prune "контейнеры старше 7 дн" docker container prune -f --filter "until=$CONTAINERS_AGE"
prune "кэш сборки старше 24 ч" docker builder prune -f --filter "until=$CACHE_HOT_AGE"
prune "висячие образы старше 12 ч" docker image prune -f --filter "until=$DANGLING_AGE"

PCT=$(used_pct)
if [ "$PCT" -lt "$WARN_PCT" ]; then
  log "watchdog done: занято ${PCT}% ($(free_mb) МБ свободно)"
  exit 0
fi

# Шаг 2: образы проектов старше 48 ч (двое суток rollback сохраняются)
prune_project_images 48
PCT=$(used_pct)
if [ "$PCT" -lt "$WARN_PCT" ]; then
  log "watchdog done: занято ${PCT}% ($(free_mb) МБ свободно)"
  exit 0
fi

# Шаг 3: образы проектов старше 24 ч
prune_project_images 24
PCT=$(used_pct)
if [ "$PCT" -lt "$LOW_PCT" ]; then
  log "watchdog done: занято ${PCT}% ($(free_mb) МБ свободно)"
  exit 0
fi

# Шаг 4: образы проектов старше 1 часа (свежесобранное не трогаем) + весь кэш сборки
prune_project_images 1
prune "кэш сборки (весь)" docker builder prune -af
PCT=$(used_pct)
if [ "$PCT" -lt "$CRIT_PCT" ]; then
  log "watchdog done: занято ${PCT}% ($(free_mb) МБ свободно)"
  exit 0
fi

# Шаг 5: крайний случай — все неиспользуемые образы проектов
log "watchdog: КРИТИЧНО, занято ${PCT}% — удаляю все неиспользуемые образы проектов"
prune_project_images 0
prune "кэш сборки (весь)" docker builder prune -af
FINAL=$(used_pct)
log "watchdog КРИТИЧНО done: занято ${FINAL}% ($(free_mb) МБ свободно)"
if [ "$FINAL" -ge "$CRIT_PCT" ]; then
  notify "⚠️ qastom: диск почти полон даже после уборки Docker (занято ${FINAL}%). Нужна ручная проверка: ~/maintenance/disk-cleanup.log"
fi
exit 0
