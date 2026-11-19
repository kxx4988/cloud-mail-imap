#!/usr/bin/env bash
# ============================================================
# cloud-mail IMAP/SMTP 网关一键安装脚本  v0.2.29
#
# 用法（由 cloud-mail 网页端「设置 → 第三方客户端」自动生成，域名已填好）：
#   curl -fsSL https://raw.githubusercontent.com/kxx4988/cloud-mail-imap/main/install.sh \
#     | sudo bash -s -- --worker https://mail.example.com --domain imap.example.com
#
# 交互说明（v0.2.29 起）：
#   · 每个关卡都有时间轴：已等待 mm:ss / 上限 mm:ss，不会让你无提示地干等
#   · 任何时刻按【回车】= 立即重新检测；不按则自动轮询（前 2 分钟 15 秒一次，之后 30 秒）
#   · 连续 3 次不通过自动打印诊断（DNS 实际解析值 / 证书 SAN / 容器状态 / 日志尾巴）
#   · 到达上限不会跳过、也不会逼你从第 1 步重跑：可选择继续等，Ctrl+C 才退出
#
# ⚠️ 每一步都强制检测：没成功 → 停下并强提醒你怎么做 → 检测通过才进下一步。
# 人工前置（无法代劳）：DNS A 记录（脚本会停下来等你加）、云厂商安全组放行
#   80（签证书）、993、2465。
# ============================================================
set -u

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/kxx4988/cloud-mail-imap/main}"
REPO_CLONE="${REPO_CLONE:-https://github.com/kxx4988/cloud-mail-imap.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cloud-mail-imap}"
IMAGE="ghcr.io/kxx4988/cloud-mail-imap:latest"
MAX_WAIT="${MAX_WAIT:-600}"            # 通用关卡单轮上限：10 分钟（到点不退出，改为继续等）
DNS_MAX_WAIT="${DNS_MAX_WAIT:-1800}"   # DNS 关卡单轮上限：30 分钟

WORKER=""
DOMAIN=""
LE_EMAIL=""
IMAP_PORT="993"
SMTP_PORT="2465"

usage() {
  sed -n '2,19p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
  cat <<'EOF'

可用参数：
  --worker  https://你的站点      必填，cloud-mail Worker 地址（不带末尾斜杠）
  --domain  imap.你的域名         必填，网关对外域名（客户端填这个）
  --email   你的邮箱             可选，Let's Encrypt 通知邮箱
  --port-imap 993                可选，宿主机 IMAP 端口
  --port-smtp 2465               可选，宿主机 SMTP 端口
  -h, --help                     显示本帮助
EOF
  exit 0
}
while [ $# -gt 0 ]; do
  case "$1" in
    --worker)   WORKER="$2"; shift 2 ;;
    --domain)   DOMAIN="$2"; shift 2 ;;
    --email)    LE_EMAIL="$2"; shift 2 ;;
    --port-imap) IMAP_PORT="$2"; shift 2 ;;
    --port-smtp) SMTP_PORT="$2"; shift 2 ;;
    --help|-h)  usage ;;
    *) echo "未知参数：$1（--help 查看用法）" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "❌ 请用 root 运行（sudo bash install.sh ...）"; exit 2; }
[ -n "$WORKER" ] || { echo "❌ 缺少 --worker https://你的cloud-mail站点地址"; exit 2; }
[ -n "$DOMAIN" ] || { echo "❌ 缺少 --domain imap.你的域名"; exit 2; }
WORKER="${WORKER%/}"

# ------------------------------------------------------------
# 抢回终端输入：curl | bash 时 stdin 是管道，直接 read 读不到键盘
#   成功 → 支持「按回车立即检测」；失败（无人值守）→ 自动退回纯轮询
# ------------------------------------------------------------
TTY_OK=0
if [ -t 0 ]; then
  TTY_OK=1
  exec 3<&0
elif [ -r /dev/tty ] && exec 3</dev/tty 2>/dev/null; then
  TTY_OK=1
fi

fmt_mmss() { printf '%02d:%02d' $(($1 / 60)) $(($1 % 60)); }

declare -a DONE=()
mark_done() { DONE+=("$1"); printf '   ✅ %s\n' "$1"; }

# 等待 $1 秒；期间按回车则立即返回 0
wait_enter() {
  local t="$1"
  if [ "$TTY_OK" = "1" ]; then
    read -r -t "$t" -u 3 _ 2>/dev/null && return 0 || return 1
  else
    sleep "$t"
    return 1
  fi
}

stop_banner() {
  cat <<EOF

╔══════════════════════════════════════════════════════════════╗
║  🛑  安 装 已 停 下 —— $1
║  ⚠️  这一步不通过，后面绝不继续、绝不跳过！
╠══════════════════════════════════════════════════════════════╣
$2
╚══════════════════════════════════════════════════════════════╝
EOF
}

# wait_for 标题 修复指引 检测命令 单轮上限秒 诊断命令(可选)
# 通过 → 返回 0；不通过 → 停在原地轮询；到上限后询问是否继续（永不跳过）
wait_for() {
  local title="$1" fix="$2" check="$3" maxs="${4:-$MAX_WAIT}" diag="${5:-}"
  local start=$SECONDS elapsed=0 interval=15 tries=0 instant=0 pre=0
  if eval "$check" >/dev/null 2>&1; then return 0; fi
  stop_banner "$title" "$fix"
  while :; do
    elapsed=$((SECONDS - start))
    if [ "$elapsed" -ge "$maxs" ]; then
      echo
      echo "🛑 已等待 $(fmt_mmss "$maxs")，仍未通过：$title"
      if [ -n "$diag" ]; then echo "🔎 诊断："; eval "$diag" 2>/dev/null | sed 's/^/     /'; fi
      echo
      echo "   不会跳过这一步。可以："
      echo "     · 按【回车】→ 继续再等 $(($maxs / 60)) 分钟（期间随时按回车立即检测）"
      echo "     · Ctrl+C   → 退出安装（解决后重跑脚本，已完成部分不会重复）"
      if [ "$TTY_OK" != "1" ]; then
        echo "   （检测到非交互环境，自动继续等待 …）"
      fi
      wait_enter "$maxs"
      start=$SECONDS
      tries=0
      echo "   ↻ 新一轮等待开始（单轮上限 $(fmt_mmss "$maxs")）"
      continue
    fi
    if [ "$elapsed" -lt 120 ]; then interval=15; else interval=30; fi
    tries=$((tries + 1))
    printf '   ⏳ 已等待 %s / 上限 %s ｜ 第 %d 次未通过 ｜ 按回车立即检测，否则 %d 秒后自动检测\n' \
      "$(fmt_mmss "$elapsed")" "$(fmt_mmss "$maxs")" "$tries" "$interval"
    if [ -n "$diag" ] && [ $((tries % 3)) -eq 0 ]; then
      echo "   🔎 诊断："
      eval "$diag" 2>/dev/null | sed 's/^/      /'
    fi
    pre=$SECONDS
    wait_enter "$interval" || true
    # read 立刻返回（终端被抢 / 后台运行）→ 连续 3 次后自动降级为纯轮询，避免空转
    if [ "$((SECONDS - pre))" -eq 0 ]; then
      instant=$((instant + 1))
      if [ "$instant" -ge 3 ] && [ "$TTY_OK" = "1" ]; then
        TTY_OK=0
        echo "   ℹ  读不到键盘输入，已自动切换为纯轮询（不需要你按回车）。"
      fi
    else
      instant=0
    fi
    if eval "$check" >/dev/null 2>&1; then
      echo "   ✅ 检测通过：「${title}」已解决，继续安装。"
      return 0
    fi
    sleep 1
  done
}

echo "=============================================="
echo " cloud-mail IMAP/SMTP 网关安装 v0.2.29"
echo "  站点   : $WORKER"
echo "  IMAP域 : $DOMAIN"
echo "  目录   : $INSTALL_DIR"
if [ "$TTY_OK" = "1" ]; then
  echo "  交互   : 支持按【回车】立即检测"
else
  echo "  交互   : 非交互环境，纯自动轮询"
fi
echo "=============================================="

# ---------------------------------------------------------- [1/8] 环境
echo "── [1/8] 检查系统环境"
if [ -z "${PUBLIC_IP:-}" ]; then
  PUBLIC_IP="$(curl -s4 --max-time 8 https://api.ipify.org || true)"
  [ -z "$PUBLIC_IP" ] && PUBLIC_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
wait_for "探测不到本机公网 IP" \
"│  修复方法：确认本机能上网；或在 VPS 控制台查到公网 IP 后：       │
│     export PUBLIC_IP=你的公网IP                                 │
│  然后重跑本脚本。                                                │" \
  '[ -n "$PUBLIC_IP" ]' 300 \
  'echo "api.ipify.org：$(curl -s4 --max-time 5 https://api.ipify.org || echo 无响应)"; echo "hostname -I：$(hostname -I 2>/dev/null || echo 取不到)"'
mark_done "本机公网 IP：${PUBLIC_IP}"

if ! command -v docker >/dev/null 2>&1; then
  echo "   ⏳ 未检测到 Docker，开始自动安装…"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq docker.io docker-compose-v2 >/dev/null 2>&1 \
      || curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q docker-ce docker-compose-plugin >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
  else
    curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
wait_for "Docker / Compose 不可用" \
"│  修复方法：手动安装 Docker + Compose v2 后等待本脚本自动检测：   │
│     curl -fsSL https://get.docker.com | sh                      │
│  装完不用退出重跑，按【回车】立即检测。                          │" \
  'command -v docker >/dev/null && docker compose version >/dev/null' 600 \
  'echo "docker：$(command -v docker || echo 未安装)"; echo "compose：$(docker compose version 2>&1 | head -1 || echo 不可用)"; echo "docker 服务：$(systemctl is-active docker 2>/dev/null || echo 未知)"'
mark_done "Docker：$(docker --version | awk '{print $3}' | tr -d ,) + Compose 可用"

# ---------------------------------------------------------- [2/8] DNS 强制关卡
echo "── [2/8] DNS A 记录检查（强制关卡）"

# 本机解析器可能缓存了旧结果/NXDOMAIN，查不到时改用公共 DNS 直查兜底
dns_resolve() {
  local ip="" ns
  ip="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}')"
  [ -z "$ip" ] && ip="$(nslookup -type=A "$DOMAIN" 2>/dev/null | awk '/^Address/ && !/:#/ {print $2; exit}')"
  if [ -z "$ip" ]; then
    for ns in 1.1.1.1 8.8.8.8; do
      if command -v dig >/dev/null 2>&1; then
        ip="$(dig +short A "$DOMAIN" "@${ns}" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)"
      elif command -v nslookup >/dev/null 2>&1; then
        ip="$(nslookup -type=A "$DOMAIN" "$ns" 2>/dev/null | awk '/^Address/ && !/:#/ {print $2; exit}')"
      fi
      [ -n "$ip" ] && break
    done
  fi
  printf '%s' "$ip"
}
dns_ok() { local ip; ip="$(dns_resolve)"; [ -n "$ip" ] && [ "$ip" = "$PUBLIC_IP" ]; }

dns_diag() {
  local ip; ip="$(dns_resolve)"
  echo "域名 $DOMAIN 当前解析：${ip:-无记录（本机与 1.1.1.1 / 8.8.8.8 均查不到）}"
  echo "本机公网 IP：$PUBLIC_IP"
  if [ -n "$ip" ] && [ "$ip" != "$PUBLIC_IP" ]; then
    echo "→ 解析值与公网 IP 不一致：主机名填错、指向旧 IP，或 Cloudflare 开了橙云代理（橙云会导致 993 连不上）"
  elif [ -z "$ip" ]; then
    echo "→ 没有任何 A 记录：确认主机记录填的是 ${DOMAIN%%.*}（不是完整域名），类型 A，值 $PUBLIC_IP"
  fi
}

wait_for "DNS 还没加好（$DOMAIN 未指向 ${PUBLIC_IP}）" \
"│  请现在去 DNS 服务商加一条 A 记录：                              │
│     主机记录 ：${DOMAIN%%.*}                                     │
│     记录类型 ：A                                                 │
│     记录值   ：${PUBLIC_IP}                                      │
│                                                                  │
│  ⚠️  域名在 Cloudflare 托管的话，必须选「仅 DNS」灰云 ☁️：      │
│      橙云（开启代理）会让 IMAP 993 端口永远无法直连！            │
│                                                                  │
│  加好后按【回车】立即检测；不按则自动轮询（生效通常 1~5 分钟）。  │" \
  'dns_ok' "$DNS_MAX_WAIT" 'dns_diag'
mark_done "DNS A 记录已生效：$DOMAIN → ${PUBLIC_IP}"

# ---------------------------------------------------------- [3/8] 目录与配置
echo "── [3/8] 写入安装目录与 .env"
mkdir -p "$INSTALL_DIR/certs" "$INSTALL_DIR/data"
cd "$INSTALL_DIR" || exit 1
if [ ! -f docker-compose.yml ]; then
  curl -fsSL "$REPO_RAW/docker-compose.yml" -o docker-compose.yml \
    || { echo "   ❌ docker-compose.yml 下载失败——终止，检查网络后重跑。"; exit 1; }
  curl -fsSL "$REPO_RAW/.env.example" -o .env.example 2>/dev/null || true
  mark_done "已从仓库下载 docker-compose.yml"
else
  mark_done "使用当前目录已有的 docker-compose.yml"
fi
cat > .env <<EOF
WORKER_BASE=$WORKER
IMAP_PORT=$IMAP_PORT
SMTP_PORT=$SMTP_PORT
EOF
chmod 600 .env
mark_done ".env 已写入（WORKER_BASE=${WORKER}）"

# ---------------------------------------------------------- [4/8] 证书 + 续签（强制关卡）
echo "── [4/8] 申请 Let's Encrypt 证书 + 续签机制验证（强制关卡）"
port80_ok() { ! (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE ':80\s'; }
wait_for "80 端口被占用（Let's Encrypt HTTP-01 验证需要它）" \
"│  修复方法：找到并停掉占用 80 端口的服务（签证书只用几分钟）：    │
│     ss -ltnp | grep ':80 '          # 看是谁占用                │
│     systemctl stop xxx              # 临时停掉它                │
│  停掉后按【回车】立即检测。                                      │" \
  'port80_ok' 600 \
  '(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ":80\s" || echo "未查到占用进程（可能需 root 才能看到进程名）"'

if [ -x "$HOME/.acme.sh/acme.sh" ]; then
  ACME="$HOME/.acme.sh/acme.sh"
else
  echo "   ⏳ 安装 acme.sh…"
  curl -fsSL https://get.acme.sh | sh -s email="${LE_EMAIL:-admin@${DOMAIN#*.}}" >/dev/null 2>&1
  ACME="$HOME/.acme.sh/acme.sh"
fi

cert_valid() {
  [ -s "$INSTALL_DIR/certs/fullchain.pem" ] && [ -s "$INSTALL_DIR/certs/privkey.pem" ] \
    && openssl x509 -in "$INSTALL_DIR/certs/fullchain.pem" -noout >/dev/null 2>&1 \
    && openssl x509 -in "$INSTALL_DIR/certs/fullchain.pem" -noout -text 2>/dev/null | grep -q "DNS:${DOMAIN}"
}
issue_cert() {
  [ -x "$ACME" ] || return 1
  [ -s "$INSTALL_DIR/certs/fullchain.pem" ] && return 1
  "$ACME" --issue -d "$DOMAIN" --standalone --server letsencrypt \
    --key-file "$INSTALL_DIR/certs/privkey.pem" \
    --fullchain-file "$INSTALL_DIR/certs/fullchain.pem" \
    --install-cert "$DOMAIN" --reloadcmd "docker restart cmimap >/dev/null 2>&1 || true" >/dev/null 2>&1 || true
}
issue_cert

cert_diag() {
  local f="$INSTALL_DIR/certs/fullchain.pem"
  if [ ! -s "$f" ]; then
    echo "certs/fullchain.pem 不存在或为空 → acme.sh 没签成功"
    echo "acme.sh 最近日志："
    tail -12 "$HOME/.acme.sh/acme.sh.log" 2>/dev/null | sed 's/^/  /' || echo "  （无日志）"
  else
    echo "证书已存在，SAN：$(openssl x509 -in "$f" -noout -text 2>/dev/null | grep -A1 'Subject Alternative Name' | tail -1 | tr -d ' ')"
    echo "期望包含：DNS:${DOMAIN}"
  fi
}
wait_for "Let's Encrypt 证书未签发成功" \
"│  常见原因（按概率排序）：                                        │
│   1. 云厂商安全组没放行 80 端口 ← 最常见！去控制台加入站规则     │
│   2. DNS 刚加还没全球生效（等 2~5 分钟即可）                     │
│   3. 本周该域名签发次数达 Let's Encrypt 限额（50 张/周）         │
│  注意：本脚本不用自签证书糊弄——签发成功才会继续。               │
│  手动放好证书到 $INSTALL_DIR/certs/ 后按【回车】也会检测通过。   │" \
  'cert_valid' 1200 'cert_diag'
mark_done "Let's Encrypt 正式证书已签发（SAN 含 ${DOMAIN}，openssl 校验通过）"

# 续签机制：优先 acme.sh 自带 cron；没有则装 systemd timer 兜底；都验证过才算数
RENEW_CONF="$HOME/.acme.sh"
if ! crontab -l 2>/dev/null | grep -q 'acme.sh'; then
  "$ACME" --install-cronjob >/dev/null 2>&1 || true
fi
if ! crontab -l 2>/dev/null | grep -q 'acme.sh'; then
  cat > /etc/systemd/system/acme-mail-renew.service <<EOF
[Unit]
Description=acme.sh daily renew (cloud-mail imap gateway)
[Service]
Type=oneshot
ExecStart=$ACME --cron --home "$RENEW_CONF"
EOF
  cat > /etc/systemd/system/acme-mail-renew.timer <<'EOF'
[Unit]
Description=daily acme.sh renewal check
[Timer]
OnCalendar=*-*-* 01:00:00
RandomizedDelaySec=1800
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload && systemctl enable --now acme-mail-renew.timer >/dev/null 2>&1 || true
fi
renew_ok() {
  crontab -l 2>/dev/null | grep -q 'acme.sh' || systemctl is-enabled acme-mail-renew.timer >/dev/null 2>&1
}
renew_diag() {
  echo "crontab 中的 acme 条目：$(crontab -l 2>/dev/null | grep -c 'acme.sh') 条"
  echo "acme-mail-renew.timer：$(systemctl is-enabled acme-mail-renew.timer 2>&1 | head -1)"
  echo "续签排期文件：$(grep -rls 'Le_NextRenewTime' "$RENEW_CONF" --include='*.conf' 2>/dev/null | head -1 || true)"
}
wait_for "证书自动续签机制未生效" \
"│  修复方法（二选一，改完按【回车】立即检测）：                    │
│   a. 手动装 cron：crontab -e 加入：                             │
│      0 1 * * * \"$ACME\" --cron --home \"$RENEW_CONF\" >/dev/null│
│   b. 手动装 systemd：                                           │
│      systemctl enable --now acme-mail-renew.timer               │" \
  'renew_ok' 600 'renew_diag'
renew_next="$(grep -rls 'Le_NextRenewTime' "$RENEW_CONF" --include='*.conf' 2>/dev/null | head -1)"
if [ -n "$renew_next" ]; then
  mark_done "证书自动续签已验证生效（定时任务在位 + 续签排期已写入）"
else
  mark_done "证书自动续签定时任务已生效（cron/systemd 检测通过）"
fi

# ---------------------------------------------------------- [5/8] 拉镜像起容器
echo "── [5/8] 拉取镜像并启动"
cd "$INSTALL_DIR" || exit 1
if docker pull "$IMAGE" >/dev/null 2>&1; then
  mark_done "镜像已拉取：$IMAGE"
else
  echo "   ⏳ GHCR 拉取失败（网络/限流），回退本地构建…"
  if [ ! -f Dockerfile ]; then
    git clone --depth 1 "$REPO_CLONE" "$INSTALL_DIR/repo" >/dev/null 2>&1 \
      && cp -R "$INSTALL_DIR/repo/src" "$INSTALL_DIR/repo/patches" "$INSTALL_DIR/repo/scripts" "$INSTALL_DIR/" \
      && cp "$INSTALL_DIR/repo/Dockerfile" "$INSTALL_DIR/repo/package.json" "$INSTALL_DIR/" \
      && mark_done "已克隆源码（用于本地构建）" \
      || { echo "   ❌ 镜像拉取 + 源码克隆都失败——终止，检查网络后重跑。"; exit 1; }
  fi
fi
docker compose up -d >/dev/null 2>&1 || { docker compose down >/dev/null 2>&1; docker compose up -d >/dev/null 2>&1; }
container_ok() { [ "$(docker inspect -f '{{.State.Status}}' cmimap 2>/dev/null)" = "running" ]; }
container_diag() {
  echo "容器状态：$(docker inspect -f '{{.State.Status}}' cmimap 2>/dev/null || echo 不存在)"
  echo "最近日志："
  docker logs --tail 12 cmimap 2>&1 | sed 's/^/  /' || echo "  （取不到日志）"
}
wait_for "容器启动失败" \
"│  修复方法：进安装目录看日志定位原因：                            │
│     cd $INSTALL_DIR && docker compose logs --tail 50            │
│  常见原因：.env 里 WORKER_BASE 填错 / 端口被占用。              │
│  处理完按【回车】立即检测（或脚本自动轮询）。                    │" \
  'container_ok' 600 'container_diag'
mark_done "容器已启动（cmimap，restart=unless-stopped，开机自启）"

# ---------------------------------------------------------- [6/8] 健康自检
echo "── [6/8] 等待容器健康"
ST=""
for i in $(seq 1 15); do
  ST="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' cmimap 2>/dev/null | tr -d '[:space:]')"
  [ "$ST" = "healthy" ] && break
  sleep 2
done
health_ok() {
  local s
  s="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' cmimap 2>/dev/null | tr -d '[:space:]')"
  [ "$s" = "healthy" ] || [ "$s" = "running" ]
}
wait_for "容器健康检查未通过（当前状态：${ST:-unknown}）" \
"│  修复方法：看容器日志定位：                                      │
│     docker logs --tail 50 cmimap                                │
│  最常见：证书文件权限不对（需 644 且容器内 uid 1000 可读）。     │" \
  'health_ok' 300 'container_diag'
mark_done "容器状态：${ST:-running}"

# ---------------------------------------------------------- [7/8] 端口握手
echo "── [7/8] 本机端口握手测试"
for p in "$IMAP_PORT" "$SMTP_PORT"; do
  handshake_ok() { timeout 8 openssl s_client -connect "127.0.0.1:${p}" -quiet </dev/null 2>/dev/null | grep -qiE 'OK|READY|ESMTP|\* '; }
  wait_for "127.0.0.1:${p} TLS 握手失败" \
"│  修复方法：容器可能在崩溃循环，看日志：                          │
│     docker logs --tail 50 cmimap                                │
│  证书异常是最常见原因（重新签发后 docker restart cmimap）。      │" \
    'handshake_ok' 300 \
    'echo "监听状态：$( (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -E ":${p}\s" || echo 该端口未监听)"; echo "容器状态：$(docker inspect -f "{{.State.Status}}" cmimap 2>/dev/null)"; docker logs --tail 8 cmimap 2>&1 | sed "s/^/  /"'
  mark_done "127.0.0.1:${p} TLS 握手正常"
done

# ---------------------------------------------------------- [8/8] 站点连通
echo "── [8/8] 校验与你 cloud-mail 站点的连通"
worker_ok() {
  local c
  c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$WORKER/" || true)"
  [ -n "$c" ] && [ "$c" != "000" ]
}
wait_for "无法访问你的 cloud-mail 站点 $WORKER" \
"│  修复方法：                                                     │
│   1. 确认 --worker 填的是你站点真实地址（浏览器能打开）          │
│   2. 本机 curl -I $WORKER 看返回                                │
│   3. 填错的话：改 $INSTALL_DIR/.env 的 WORKER_BASE 后           │
│      docker compose up -d 重建，再按【回车】检测                 │" \
  'worker_ok' 600 \
  'echo "curl -I 结果："; curl -sI --max-time 8 "$WORKER/" 2>&1 | head -3 | sed "s/^/  /" || echo "  无响应"'
mark_done "站点可达：$WORKER"

# ============================================================
#  最终报告：已完成 + 强提醒（脚本无法代劳的事项）
# ============================================================
TOTAL_MIN=$((SECONDS / 60))
echo
echo "============================================================"
echo "                    ✅ 安 装 成 功"
echo "============================================================"
echo
echo "✅ 已完成 ${#DONE[@]} 项（全部当场验证过，总耗时约 ${TOTAL_MIN} 分钟）："
for d in "${DONE[@]}"; do echo "   · $d"; done

echo
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ⚠️⚠️  脚 本 【无 法 代 劳】 的 事，还 没 做，必 须 人 工  ⚠️⚠️  ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  1. 【必须】云厂商安全组/防火墙放行端口：$IMAP_PORT $SMTP_PORT"
echo "║       （本机能握手≠外网能连！Oracle/AWS/阿里云要在控制台   ║"
echo "║         加入站规则；系统内 ufw/iptables 本脚本没动）       ║"
echo "║  2. 【必须】应用密码要你自己生成：                        ║"
echo "║       登录 $WORKER → 个人设置 → 第三方客户端 →            ║"
echo "║       生成 16 位应用密码（客户端密码栏填它，不是登录密码）║"
echo "╚══════════════════════════════════════════════════════════╝"
echo
echo "📮 客户端配置（做完上面 1、2 后填这些）："
echo "   ┌──────────────────────────────────────────────"
echo "   │ 收件 IMAP：$DOMAIN  端口 $IMAP_PORT  加密 SSL/TLS"
echo "   │ 发件 SMTP：$DOMAIN  端口 $SMTP_PORT  加密 SSL/TLS"
echo "   │ 用户名    ：你的完整邮箱地址"
echo "   │ 密码      ：站点生成的应用密码（第 2 条）"
echo "   └──────────────────────────────────────────────"
echo
echo "🔁 证书续签：已装定时任务（每天 01:00 检查），无需人工干预。"
echo "   验证：crontab -l | grep acme   或   systemctl list-timers | grep acme"
echo
echo "🎉 全部完成。没做第 1、2 条之前，客户端是登录不了的——别跳过。"
exit 0
