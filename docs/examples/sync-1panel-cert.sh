#!/usr/bin/env bash
# cloud-mail IMAP 网关（S37）证书同步：1Panel 内置 ACME → 容器 certs/
#
# 背景：imap.example.com 的证书由 1Panel 内置 ACME（lego）签发，PEM 只存在
#       /opt/1panel/db/agent.db 的 website_ssls 表里，磁盘上没有文件（该域名没建站）。
#       容器读的是手工拷进 /opt/cloud-mail-imap/certs 的副本，续签后不会自动更新。
#
# 行为：
#   1. 从 agent.db 只读取最新证书 → 与 existing 指纹比对，相同直接退出（不动容器）
#   2. 不同则三道校验（域名 SAN / 公私钥配对 / 剩余 ≥ 7 天）后原子替换，备份旧文件
#   3. 仅当容器处于 running 时重启；用户手动停掉的容器不会被脚本拉起
#   4. 每次运行都检查容器内证书剩余天数，<30 天 WARN、<14 天 CRITICAL
#
# 用法：
#   sync-1panel-cert.sh              正常同步（timer 调用）
#   sync-1panel-cert.sh --status     打印现状，不做任何修改
#   sync-1panel-cert.sh --dry-run    走完比对与校验，只打印不落盘
#   sync-1panel-cert.sh --force      忽略指纹差异，强制重新导出+替换
#   sync-1panel-cert.sh --rollback   恢复到最近一次备份
#   sync-1panel-cert.sh --selftest   自检：用自签证书与临时库跑完整流程（需要 sqlite3/openssl）
#
# v0.2.19 / S37 P5

set -uo pipefail

DOMAIN="${DOMAIN:-imap.example.com}"
APP_DIR="${APP_DIR:-/opt/cloud-mail-imap}"
CERT_DIR="${CERT_DIR:-$APP_DIR/certs}"
BACKUP_DIR="${BACKUP_DIR:-$CERT_DIR/backup}"
PANEL_DB="${PANEL_DB:-/opt/1panel/db/agent.db}"
SITE_SSL_DIR="${SITE_SSL_DIR:-/opt/1panel/www/sites/$DOMAIN/ssl}"
CONTAINER="${CONTAINER:-cmimap}"
LOG_FILE="${LOG_FILE:-/var/log/cmimap-cert-sync.log}"
STATE_DIR="${STATE_DIR:-/var/lib/cmimap-cert-sync}"
ENV_FILE="${ENV_FILE:-/etc/cmimap-cert-sync.env}"
OWNER="${OWNER:-ubuntu:ubuntu}"
LOG_MAX_LINES="${LOG_MAX_LINES:-500}"
BACKUP_KEEP="${BACKUP_KEEP:-5}"
MIN_VALID_DAYS="${MIN_VALID_DAYS:-7}"
WARN_DAYS="${WARN_DAYS:-30}"
CRIT_DAYS="${CRIT_DAYS:-14}"
RETRIES="${RETRIES:-2}"
RETRY_SLEEP="${RETRY_SLEEP:-10}"
RESTART_WAIT="${RESTART_WAIT:-40}"

MODE="sync"
case "${1:-}" in
  --status)   MODE="status" ;;
  --dry-run)  MODE="dry-run" ;;
  --force)    MODE="force" ;;
  --rollback) MODE="rollback" ;;
  --selftest) MODE="selftest" ;;
  --help|-h)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  "") ;;
  *) echo "未知参数：$1（--help 查看用法）" >&2; exit 2 ;;
esac

# ---------- 基础工具 ----------

log() {
  local level="$1"; shift
  local line
  line="$(date '+%F %T') [$level] $*"
  printf '%s\n' "$line"
  if [ "$MODE" != "selftest" ] && [ -w "$(dirname "$LOG_FILE")" ] 2>/dev/null; then
    printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null || true
    # 自截断：只保留最近 LOG_MAX_LINES 行
    local n
    n=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "${n:-0}" -gt "$LOG_MAX_LINES" ]; then
      tail -n "$LOG_MAX_LINES" "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv -f "$LOG_FILE.tmp" "$LOG_FILE" 2>/dev/null || true
    fi
  fi
}

finish() {
  # $1=退出码 $2=说明（失败时写 marker）
  local code="$1" msg="${2:-}"
  if [ "$MODE" = "selftest" ]; then exit "$code"; fi
  if [ "$code" -eq 0 ]; then
    rm -f "$STATE_DIR/last-failed" 2>/dev/null || true
  else
    mkdir -p "$STATE_DIR" 2>/dev/null || true
    printf '%s %s\n' "$(date '+%F %T')" "$msg" > "$STATE_DIR/last-failed" 2>/dev/null || true
    notify "❌ cmimap 证书同步失败\n${msg:-未提供原因}\n主机：$(hostname)　时间：$(date '+%F %T')"
  fi
  exit "$code"
}

notify() {
  # 可选 Telegram 告警：/etc/cmimap-cert-sync.env 里配 TG_BOT_TOKEN + TG_CHAT_ID
  [ -f "$ENV_FILE" ] || return 0
  # shellcheck disable=SC1090
  . "$ENV_FILE" 2>/dev/null || return 0
  [ -n "${TG_BOT_TOKEN:-}" ] && [ -n "${TG_CHAT_ID:-}" ] || return 0
  curl -sS --max-time 10 -X POST \
    "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TG_CHAT_ID}" \
    --data-urlencode "text=$(printf '%b' "$1")" > /dev/null 2>&1 || true
}

need_cmd() {
  command -v "$1" > /dev/null 2>&1 || { log ERROR "缺少命令：$1"; return 1; }
}

# ---------- 证书读取 ----------

# 从 1Panel 数据库读单个字段：单字段 + LIMIT 1，PEM 内部换行不会被破坏
db_field() {
  sqlite3 -readonly "file:${PANEL_DB}?mode=ro" \
    "SELECT $1 FROM website_ssls WHERE primary_domain='${DOMAIN}' ORDER BY expire_date DESC LIMIT 1;" 2>/dev/null
}

# 输出：成功时把 pem 写到 $1、key 写到 $2；失败返回 1
read_panel_cert() {
  local crt="$1" key="$2" pem pkey
  : > "$crt"; : > "$key"

  if [ -r "$PANEL_DB" ] && command -v sqlite3 > /dev/null 2>&1; then
    pem=$(db_field "pem")
    pkey=$(db_field "private_key")
    if [ -n "$pem" ] && [ -n "$pkey" ]; then
      printf '%s\n' "$pem"  | tr -d '\r' > "$crt"
      printf '%s\n' "$pkey" | tr -d '\r' > "$key"
      log INFO "证书来源：1Panel 数据库 ${PANEL_DB}（website_ssls）"
      return 0
    fi
    log WARN "数据库里没查到 ${DOMAIN} 的证书记录"
  else
    log WARN "无法读取 ${PANEL_DB}（不存在、无权限或缺少 sqlite3）"
  fi

  # 兜底：若将来该域名建了站，1Panel 会把证书落到站点目录
  if [ -r "$SITE_SSL_DIR/fullchain.pem" ] && [ -r "$SITE_SSL_DIR/privkey.pem" ]; then
    cp -f "$SITE_SSL_DIR/fullchain.pem" "$crt" 2>/dev/null || return 1
    cp -f "$SITE_SSL_DIR/privkey.pem"   "$key" 2>/dev/null || return 1
    log INFO "证书来源：站点目录 ${SITE_SSL_DIR}"
    return 0
  fi

  log ERROR "两个来源都拿不到证书，保持现状不动"
  return 1
}

fp_of() {
  openssl x509 -in "$1" -noout -fingerprint -sha256 2>/dev/null \
    | sed 's/^.*=//' | tr -d ':' | tr 'A-F' 'a-f'
}

days_left() {
  local crt="$1" end now
  [ -s "$crt" ] || { echo -1; return; }
  end=$(date -d "$(openssl x509 -in "$crt" -noout -enddate 2>/dev/null | cut -d= -f2)" +%s 2>/dev/null) || { echo -1; return; }
  now=$(date +%s)
  echo $(( (end - now) / 86400 ))
}

san_has_domain() {
  openssl x509 -in "$1" -noout -text 2>/dev/null \
    | grep -A1 'Subject Alternative Name' | tr -d ' ' | grep -q "DNS:${DOMAIN}\([,]$\|$\)"
}

pubkey_fp_of_cert() {
  openssl x509 -in "$1" -noout -pubkey 2>/dev/null | openssl sha256 2>/dev/null | awk '{print $NF}'
}

pubkey_fp_of_key() {
  openssl pkey -in "$1" -pubout 2>/dev/null | openssl sha256 2>/dev/null | awk '{print $NF}'
}

# 三道校验：可解析 + 域名 + 公私钥配对 + 剩余天数
validate_pair() {
  local crt="$1" key="$2" a b d
  [ -s "$crt" ] && [ -s "$key" ] || { log ERROR "校验失败：证书或私钥为空"; return 1; }
  openssl x509 -in "$crt" -noout > /dev/null 2>&1 || { log ERROR "校验失败：证书无法解析"; return 1; }
  openssl pkey -in "$key" -noout > /dev/null 2>&1 || { log ERROR "校验失败：私钥无法解析"; return 1; }

  san_has_domain "$crt" || { log ERROR "校验失败：SAN 里没有 ${DOMAIN}"; return 1; }

  a=$(pubkey_fp_of_cert "$crt")
  b=$(pubkey_fp_of_key "$key")
  [ -n "$a" ] && [ "$a" = "$b" ] || { log ERROR "校验失败：证书与私钥不配对"; return 1; }

  d=$(days_left "$crt")
  [ "$d" -ge "$MIN_VALID_DAYS" ] || { log ERROR "校验失败：新证书剩余 ${d} 天，低于阈值 ${MIN_VALID_DAYS} 天"; return 1; }

  log INFO "校验通过（域名 ${DOMAIN}，公私钥配对，剩余 ${d} 天）"
  return 0
}

# ---------- 容器 ----------

container_state() {
  # 注意：docker inspect 找不到对象时会在 stdout 打一个空行，必须 strip 后再判断，
  # 否则 "$(container_state)" 等于 "\nabsent"，与 "absent" 比较会失败
  local s
  s=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null | tr -d '[:space:]')
  [ -n "$s" ] && printf '%s' "$s" || printf 'absent'
}

container_cert_days() {
  days_left "$CERT_DIR/fullchain.pem"
}

restart_container() {
  local st i s
  st=$(container_state)
  if [ "$st" != "running" ]; then
    log WARN "容器当前为 ${st}（非运行态），只同步文件、不重启；下次启动即生效"
    return 0
  fi
  if [ "${DRY_RUN:-0}" = "1" ]; then
    log INFO "[dry-run] 跳过 docker restart ${CONTAINER}"
    return 0
  fi
  log INFO "重启容器 ${CONTAINER}"
  docker restart "$CONTAINER" > /dev/null 2>&1 || { log ERROR "docker restart 失败"; return 1; }
  for i in $(seq 1 $(( RESTART_WAIT / 2 )) ); do
    sleep 2
    s=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null | tr -d '[:space:]')
    case "$s" in
      healthy|running) log INFO "容器已恢复：${s}"; return 0 ;;
      unhealthy) log ERROR "容器重启后 unhealthy"; return 1 ;;
    esac
  done
  log ERROR "容器重启后 ${RESTART_WAIT}s 内未就绪"
  return 1
}

# ---------- 主流程 ----------

write_cert_pair() {
  local crt="$1" key="$2" ts bk
  ts=$(date +%Y%m%d-%H%M%S)
  bk="$BACKUP_DIR/$ts"

  if [ "${DRY_RUN:-0}" = "1" ]; then
    log INFO "[dry-run] 将备份到 ${bk} 并替换 ${CERT_DIR}/{fullchain,privkey}.pem"
    return 0
  fi

  mkdir -p "$bk" || { log ERROR "无法创建备份目录 ${bk}"; return 1; }
  [ -f "$CERT_DIR/fullchain.pem" ] && cp -p "$CERT_DIR/fullchain.pem" "$bk/fullchain.pem" 2>/dev/null
  [ -f "$CERT_DIR/privkey.pem" ]   && cp -p "$CERT_DIR/privkey.pem"   "$bk/privkey.pem"   2>/dev/null
  log INFO "旧证书已备份：${bk}"

  install -m 644 "$crt" "$CERT_DIR/fullchain.pem.new" || { log ERROR "写入临时文件失败"; return 1; }
  install -m 600 "$key" "$CERT_DIR/privkey.pem.new"   || { log ERROR "写入临时文件失败"; return 1; }
  mv -f "$CERT_DIR/fullchain.pem.new" "$CERT_DIR/fullchain.pem" || { log ERROR "替换 fullchain 失败"; return 1; }
  mv -f "$CERT_DIR/privkey.pem.new"   "$CERT_DIR/privkey.pem"   || { log ERROR "替换 privkey 失败"; return 1; }
  if id "$(echo "$OWNER" | cut -d: -f1)" > /dev/null 2>&1; then
    chown "$OWNER" "$CERT_DIR/fullchain.pem" "$CERT_DIR/privkey.pem" 2>/dev/null || true
  fi
  chmod 644 "$CERT_DIR/fullchain.pem"; chmod 600 "$CERT_DIR/privkey.pem"

  # 只留最近 BACKUP_KEEP 组
  ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | sort | head -n "-$BACKUP_KEEP" | while read -r old; do
    [ -n "$old" ] && rm -rf "$old"
  done
  return 0
}

rollback() {
  local latest
  latest=$(ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | sort | tail -1)
  [ -n "$latest" ] || { log ERROR "没有可用的备份"; return 1; }
  log WARN "从备份恢复：$latest"
  if [ "${DRY_RUN:-0}" = "1" ]; then log INFO "[dry-run] 跳过实际恢复"; return 0; fi
  cp -f "$latest/fullchain.pem" "$CERT_DIR/fullchain.pem" || return 1
  cp -f "$latest/privkey.pem"   "$CERT_DIR/privkey.pem"   || return 1
  restart_container || return 1
  log INFO "回滚完成，当前证书剩余 $(container_cert_days) 天"
  return 0
}

do_status() {
  local d dbdays
  echo "──── cmimap 证书同步现状 ────"
  echo "域名          : $DOMAIN"
  echo "容器          : $CONTAINER（$(container_state)）"
  if [ -s "$CERT_DIR/fullchain.pem" ]; then
    d=$(container_cert_days)
    echo "容器证书       : $(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -subject 2>/dev/null | sed 's/^subject=//')"
    echo "  到期         : $(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -enddate 2>/dev/null | cut -d= -f2)（剩 ${d} 天）"
    echo "  指纹         : $(fp_of "$CERT_DIR/fullchain.pem")"
    echo "  文件时间     : $(date -r "$CERT_DIR/fullchain.pem" '+%F %T' 2>/dev/null || stat -c %y "$CERT_DIR/fullchain.pem" 2>/dev/null)"
  else
    echo "容器证书       : (缺失)"
  fi
  if [ -r "$PANEL_DB" ] && command -v sqlite3 > /dev/null 2>&1; then
    dbdays=$(sqlite3 -readonly "file:${PANEL_DB}?mode=ro" \
      "SELECT expire_date FROM website_ssls WHERE primary_domain='${DOMAIN}' ORDER BY expire_date DESC LIMIT 1;" 2>/dev/null)
    echo "1Panel 记录    : ${dbdays:-（无）}"
  else
    echo "1Panel 记录    : 无法读取 $PANEL_DB"
  fi
  local lastbk en act
  lastbk=$(ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | sort | tail -1)
  echo "最近备份       : ${lastbk:-（无）}"
  if [ -f "$STATE_DIR/last-failed" ]; then
    echo "上次失败       : $(cat "$STATE_DIR/last-failed")"
  else
    echo "上次失败       : 无"
  fi
  en=$(systemctl is-enabled cmimap-cert-sync.timer 2>/dev/null | head -1); en=${en:-未安装}
  act=$(systemctl is-active cmimap-cert-sync.timer 2>/dev/null | head -1); act=${act:-inactive}
  echo "定时器         : ${en} / ${act}"
  echo "──── 最近 8 行日志 ────"
  tail -n 8 "$LOG_FILE" 2>/dev/null || echo "（无日志）"
  return 0
}

do_sync() {
  local tmpdir crt key cur_fp new_fp d
  need_cmd openssl || return 1

  d=$(container_cert_days)
  if [ "$d" -ge 0 ]; then
    if [ "$d" -lt "$CRIT_DAYS" ]; then
      log ERROR "⚠️ 容器内证书仅剩 ${d} 天，请立刻在 1Panel 检查续签"
      notify "⚠️ cmimap 证书只剩 ${d} 天，1Panel 续签可能已失败"
    elif [ "$d" -lt "$WARN_DAYS" ]; then
      log WARN "容器内证书剩 ${d} 天（1Panel 一般提前 30 天续签，若长期不降需检查）"
    fi
  fi

  tmpdir=$(mktemp -d) || { log ERROR "mktemp 失败"; return 1; }
  crt="$tmpdir/fullchain.pem"; key="$tmpdir/privkey.pem"

  if ! read_panel_cert "$crt" "$key"; then
    rm -rf "$tmpdir"; return 1
  fi
  if ! validate_pair "$crt" "$key"; then
    rm -rf "$tmpdir"; return 1
  fi

  cur_fp=$(fp_of "$CERT_DIR/fullchain.pem" 2>/dev/null || true)
  new_fp=$(fp_of "$crt")
  log INFO "指纹 现有=${cur_fp:-none} 1Panel=${new_fp:-none}"

  if [ "$cur_fp" = "$new_fp" ] && [ "$MODE" != "force" ]; then
    log INFO "证书无变化，跳过（不重启容器）"
    rm -rf "$tmpdir"; return 0
  fi

  if ! write_cert_pair "$crt" "$key"; then
    log ERROR "写入证书失败，尝试回滚"
    rm -rf "$tmpdir"
    rollback
    return 1
  fi
  rm -rf "$tmpdir"

  if ! restart_container; then
    log ERROR "重启失败，回滚证书"
    rollback && log WARN "已回滚到旧证书"
    return 1
  fi

  log INFO "同步完成，容器内证书剩余 $(container_cert_days) 天"
  notify "✅ cmimap 证书已同步\n到期：$(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -enddate 2>/dev/null | cut -d= -f2)\n指纹：$(fp_of "$CERT_DIR/fullchain.pem")"
  return 0
}

# ---------- 自检 ----------

do_selftest() {
  local root rc=0 pass=0 fail=0
  root=$(mktemp -d)
  export DOMAIN="imap.selftest.local"
  export APP_DIR="$root/app"
  export CERT_DIR="$APP_DIR/certs"
  export BACKUP_DIR="$CERT_DIR/backup"
  export PANEL_DB="$root/agent.db"
  export SITE_SSL_DIR="$root/nosuch"
  export CONTAINER="cmimap-selftest-nonexistent"
  export LOG_FILE="$root/sync.log"
  export STATE_DIR="$root/state"
  export DRY_RUN=1
  mkdir -p "$CERT_DIR" "$STATE_DIR"

  ok() { pass=$((pass+1)); printf '  ✓ %s\n' "$1"; }
  bad() { fail=$((fail+1)); rc=1; printf '  ✗ %s\n' "$1"; }
  chk() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

  echo "── 准备：自签两套证书 ──"
  local A="$root/a.pem" B="$root/b.pem" AK="$root/a.key" BK="$root/b.key"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$AK" -out "$A" -days 90 \
    -subj "/CN=$DOMAIN" -addext "subjectAltName=DNS:$DOMAIN" > /dev/null 2>&1
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$BK" -out "$B" -days 60 \
    -subj "/CN=$DOMAIN" -addext "subjectAltName=DNS:$DOMAIN" > /dev/null 2>&1
  chk "自签证书生成" "[ -s '$A' ] && [ -s '$B' ]"

  echo "── 1) 数据库读取 ──"
  sqlite3 "$PANEL_DB" "CREATE TABLE website_ssls (id INTEGER PRIMARY KEY, primary_domain TEXT, pem TEXT, private_key TEXT, expire_date TEXT);"
  sqlite3 "$PANEL_DB" "INSERT INTO website_ssls (primary_domain,pem,private_key,expire_date) VALUES ('$DOMAIN','$(cat "$A")','$(cat "$AK")','2027-01-01');"
  local c="$root/db.pem" k="$root/db.key"
  chk "read_panel_cert 成功" "read_panel_cert '$c' '$k' > /dev/null 2>&1"
  chk "读出的证书字节数 > 800" "[ \$(wc -c < '$c') -gt 800 ]"
  chk "读出的 PEM 以 -----END 结尾" "grep -q 'END CERTIFICATE' '$c'"

  echo "── 2) 三道校验 ──"
  chk "正常证书通过校验" "validate_pair '$A' '$AK' > /dev/null 2>&1"
  chk "错配私钥被拒" "! validate_pair '$A' '$BK' > /dev/null 2>&1"

  local other="$root/other.pem" otherk="$root/other.key"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$otherk" -out "$other" -days 90 \
    -subj "/CN=wrong.example.com" -addext "subjectAltName=DNS:wrong.example.com" > /dev/null 2>&1
  chk "域名不符被拒" "! validate_pair '$other' '$otherk' > /dev/null 2>&1"

  local short="$root/short.pem" shortk="$root/short.key"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$shortk" -out "$short" -days 2 \
    -subj "/CN=$DOMAIN" -addext "subjectAltName=DNS:$DOMAIN" > /dev/null 2>&1
  chk "剩余 2 天被拒（阈值 7）" "! validate_pair '$short' '$shortk' > /dev/null 2>&1"

  echo "── 3) 指纹与剩余天数 ──"
  chk "A≠B 指纹不同" "[ \"\$(fp_of '$A')\" != \"\$(fp_of '$B')\" ]"
  chk "剩余天数在 88~90 之间" "d=\$(days_left '$A'); [ \$d -ge 88 ] && [ \$d -le 90 ]"
  chk "缺失文件返回 -1" "[ \"\$(days_left '$root/nosuch.pem')\" = '-1' ]"

  echo "── 4) 无变化时不动容器 ──"
  cp -f "$A" "$CERT_DIR/fullchain.pem"; cp -f "$AK" "$CERT_DIR/privkey.pem"
  local before
  before=$(fp_of "$CERT_DIR/fullchain.pem")
  chk "sync 返回 0" "do_sync > /dev/null 2>&1"
  chk "文件未被改动（dry-run 且同指纹）" "[ \"\$(fp_of '$CERT_DIR/fullchain.pem')\" = '$before' ]"

  echo "── 5) 有变化时 dry-run 不落盘 ──"
  sqlite3 "$PANEL_DB" "UPDATE website_ssls SET pem='$(cat "$B")', private_key='$(cat "$BK")' WHERE primary_domain='$DOMAIN';"
  chk "sync 返回 0" "do_sync > /dev/null 2>&1"
  chk "dry-run 未替换文件" "[ \"\$(fp_of '$CERT_DIR/fullchain.pem')\" = '$before' ]"
  chk "dry-run 未创建备份" "[ -z \"\$(ls -1d '$BACKUP_DIR'/*/ 2>/dev/null)\" ]"

  echo "── 6) 非运行态容器：只同步不重启 ──"
  export DRY_RUN=0
  # 把日志收回临时文件，便于断言「确实没重启」
  log() { local lv="$1"; shift; printf '[%s] %s\n' "$lv" "$*" >> "$root/state.log"; }
  chk "容器状态识别为 absent" "[ \"\$(container_state)\" = 'absent' ]"
  chk "restart_container 在 absent 时返回 0" "restart_container > /dev/null 2>&1"
  chk "日志明确说明非运行态、不重启" "grep -q '非运行态' '$root/state.log'"

  echo "── 7) 数据库异常时保持现状 ──"
  local keep
  keep=$(fp_of "$CERT_DIR/fullchain.pem")
  sqlite3 "$PANEL_DB" "DELETE FROM website_ssls;"
  chk "read_panel_cert 失败" "! read_panel_cert '$root/x.pem' '$root/x.key' > /dev/null 2>&1"
  chk "certs 未被破坏" "[ \"\$(fp_of '$CERT_DIR/fullchain.pem')\" = '$keep' ]"

  echo
  echo "自检结果：通过 $pass 项，失败 $fail 项"
  rm -rf "$root"
  return "$rc"
}

# ---------- 入口 ----------

case "$MODE" in
  status)   do_status; exit 0 ;;
  rollback) rollback; finish $? "手动回滚失败" ;;
  selftest) do_selftest; exit $? ;;
  dry-run)  DRY_RUN=1; do_sync; finish $? "dry-run 同步失败" ;;
  force)    DRY_RUN=0; do_sync; finish $? "强制同步失败" ;;
  *)        DRY_RUN=0; do_sync; finish $? "同步失败" ;;
esac
