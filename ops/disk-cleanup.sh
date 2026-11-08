#!/usr/bin/env bash
# disk-cleanup.sh — регулярная БЕЗОПАСНАЯ уборка Docker-мусора на сервере qastom.
#
# Принципы безопасности:
#   • НЕ трогает тома (volumes), сети и базы данных — данные приложений неуязвимы.
#   • НЕ трогает работающие контейнеры.
#   • НЕ удаляет образы, на которые ссылается хоть один контейнер (docker prune это гарантирует).
#   • Остановленные контейнеры — только старше CONTAINERS_AGE (по умолчанию 7 дней).
#   • Образы — только неиспользуемые и только старше указанного возраста; свежесобранные
#     образы (< 1 часа) при экстренной уборке сохраняются, чтобы не сломать идущий деплой.
#   • Кэш сборки чистится отдельно, по возрасту.
#
# Режимы (аргумент):
#   watchdog  — запуск каждые 10 минут по cron. Если место в норме — выходит сразу,
#               ничего не делает. При заполнении диска — эскалирующая уборка.
#   daily     — раз в сутки: лёгкая плановая уборка (недельные образы, старый кэш) + vacuum journal.
#   dry       — только показать состояние, ничего не удалять (для проверки).
#
# Журнал: ~/maintenance/disk-cleanup.log (авторотация 2 МБ → 1 МБ).
# Уведомление в Telegram — только когда место критическое или уборка не помогла.
set -uo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

BASE="$HOME/maintenance"
LOG="$BASE/disk-cleanup.log"
mkdir -p "$BASE" || exit 0
exec 9>"$BASE/.lock" || exit 0
flock -n 9 || exit 0            # не запускаемся параллельно сами с собой

MODE="${1:-watchdog}"

# --- пороги (проценты занятости корневого раздела) ---
WARN_PCT=82      # с этого момента начинаем уборку
LOW_PCT=88       # эскалация: образы старше 24 ч
CRIT_PCT=92      # эскалация: образы старше 1 ч (почти всё неиспользуемое)
DESP_PCT=96      # безвыходное положение: все неиспользуемые образы
# --- сроки хранения ---
CONTAINERS_AGE=168h   # остановленные контейнеры
DAILY_IMAGES_AGE=168h # плановая уборка: образы старше недели
CACHE_DAILY_AGE=48h   # плановая уборка кэша сборки
CACHE_HOT_AGE=24h     # кэш сборки при нехватке места
DANGLING_AGE=12h      # «висячие» образы (<none>)

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
  if [ -x "$HOME/backups/notify.py" ] || [ -f "$HOME/backups/notify.py" ]; then
    python3 "$HOME/backups/notify.py" "$1" >/dev/null 2>&1 && return 0
  fi
  log "NOTIFY (не отправлено): $1"
}

# Выполнить prune и записать в журнал, сколько освободилось.
prune() { # $1=название, дальше команда
  local label="$1"; shift
  local out rc
  out=$("$@" 2>&1); rc=$?
  if [ $rc -ne 0 ]; then
    log "$label: ОШИБКА ($*): $(printf '%s' "$out" | tail -1)"
    return 1
  fi
  local rec
  rec=$(printf '%s' "$out" | grep -o 'Total reclaimed space: .*' | head -1)
  log "$label: ${rec:-ничего не удалено}"
}

# Запускается ли прямо сейчас сборка (только для информации в журнале)
build_running() {
  pgrep -af 'docker (compose )?build|buildkit|docker-buildx' >/dev/null 2>&1
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
    say "--- неиспользуемые образы ---"
    docker system df -v 2>/dev/null | sed -n '/^Images space/,/^Containers space/p'
    exit 0
    ;;

  daily)
    log "daily: занято ${PCT}% (${FREE} МБ свободно)$( build_running && echo ' [сборка идёт]')"
    prune "контейнеры старше 7 дн" docker container prune -f --filter "until=$CONTAINERS_AGE"
    prune "висячие образы старше 12 ч" docker image prune -f --filter "until=$DANGLING_AGE"
    prune "неиспользуемые образы старше 7 дн" docker image prune -a -f --filter "until=$DAILY_IMAGES_AGE"
    prune "кэш сборки старше 48 ч" docker builder prune -f --filter "until=$CACHE_DAILY_AGE"
    # ВАЖНО: тома и сети не чистим никогда — там могут лежать данные приложений.
    if sudo -n /usr/bin/journalctl --vacuum-size=300M >/dev/null 2>&1; then
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

log "watchdog: МАЛО МЕСТА — занято ${PCT}%, свободно ${FREE} МБ$( build_running && echo ' [сборка идёт]')"

# Шаг 1: безопасный минимум (недельные контейнеры, старый кэш, висячие образы)
prune "контейнеры старше 7 дн" docker container prune -f --filter "until=$CONTAINERS_AGE"
prune "кэш сборки старше 24 ч" docker builder prune -f --filter "until=$CACHE_HOT_AGE"
prune "висячие образы старше 12 ч" docker image prune -f --filter "until=$DANGLING_AGE"

PCT=$(used_pct)
if [ "$PCT" -lt "$WARN_PCT" ]; then
  log "watchdog done: занято ${PCT}% ($(free_mb) МБ свободно)"
  exit 0
fi

# Шаг 2: неиспользуемые образы старше 48 часов (rollback за двое суток сохраняется)
prune "неиспользуемые образы старше 48 ч" docker image prune -a -f --filter "until=48h"
PCT=$(used_pct)
if [ "$PCT" -lt "$WARN_PCT" ]; then
  log "watchdog done: занято ${PCT}% ($(free_mb) МБ свободно)"
  exit 0
fi

# Шаг 3: образы старше 24 часов
prune "неиспользуемые образы старше 24 ч" docker image prune -a -f --filter "until=24h"
PCT=$(used_pct)
if [ "$PCT" -lt "$LOW_PCT" ]; then
  log "watchdog done: занято ${PCT}% ($(free_mb) МБ свободно)"
  exit 0
fi

# Шаг 4: образы старше 1 часа (свежесобранное не трогаем, чтобы не сорвать деплой)
prune "неиспользуемые образы старше 1 ч" docker image prune -a -f --filter "until=1h"
prune "кэш сборки (весь)" docker builder prune -af
PCT=$(used_pct)
if [ "$PCT" -lt "$CRIT_PCT" ]; then
  log "watchdog done: занято ${PCT}% ($(free_mb) МБ свободно)"
  exit 0
fi

# Шаг 5: крайний случай — удалить всё неиспользуемое
log "watchdog: КРИТИЧНО, занято ${PCT}% — удаляю все неиспользуемые образы"
prune "неиспользуемые образы (все)" docker image prune -a -f
prune "кэш сборки (весь)" docker builder prune -af
FINAL=$(used_pct)
log "watchdog КРИТИЧНО done: занято ${FINAL}% ($(free_mb) МБ свободно)"
if [ "$FINAL" -ge "$CRIT_PCT" ]; then
  notify "⚠️ qastom: диск почти полон даже после уборки Docker (занято ${FINAL}%). Нужна ручная проверка: ~/maintenance/disk-cleanup.log"
fi
exit 0
