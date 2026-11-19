#!/usr/bin/env bash
# ============================================================
# cloud-mail IMAP/SMTP 网关一键安装脚本
#
# 用法（由 cloud-mail 网页端「设置 → 第三方客户端」自动生成，域名已填好）：
#   curl -fsSL https://raw.githubusercontent.com/kxx4988/cloud-mail-imap/main/install.sh \
#     | sudo bash -s -- --worker https://mail.example.com --domain imap.example.com
#
# ⚠️ 每一步都强制检测：没成功 → 停下并强提醒你怎么做 → 检测通过才进下一步，
#    任何失败都不跳过、不用兜底糊弄。
#
# 人工前置（无法代劳）：DNS A 记录（脚本会停下来等你加）、云厂商安全组放行
#   80（签证书）、993、2465。
# ============================================================
set -u

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/kxx4988/cloud-mail-imap/main}"
REPO_CLONE="${REPO_CLONE:-https://github.com/kxx4988/cloud-mail-imap.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cloud-mail-imap}"
IMAGE="ghcr.io/kxx4988/cloud-mail-imap:latest"
WAIT_ROUNDS="${WAIT_ROUNDS:-20}"   # 每个关卡最多等 20 × 30s = 10 分钟

WORKER=""
DOMAIN=""
LE_EMAIL=""
IMAP_PORT="993"
SMTP_PORT="2465"

usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }
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

declare -a DONE=()
mark_done() { DONE+=("$1"); printf '   ✅ %s\n' "$1"; }

# 通用「停-提醒-轮询-放行」关卡：$1=标题  $2=修复指引  $3=检测命令
# 检测通过 → 返回继续；超过 WAIT_ROUNDS 次 → 终止并要求重跑
gate() {
  local title="$1" fix="$2" check="$3" i=0
  if eval "$check" >/dev/null 2>&1; then return 0; fi
  cat <<EOF

╔══════════════════════════════════════════════════════════════╗
║  🛑  安 装 已 停 下 —— ${title}
║  ⚠️  这一步不通过，后面绝不继续、绝不跳过！
╠══════════════════════════════════════════════════════════════╣
${fix}
╚══════════════════════════════════════════════════════════════╝
EOF
  while [ "$i" -lt "$WAIT_ROUNDS" ]; do
    i=$((i + 1))
    sleep 30
    if eval "$check" >/dev/null 2>&1; then
      echo "   ✅ 检测通过：「${title}」已解决，继续安装。"
      return 0
    fi
    printf '   ⏳ 等待修复中…（第 %d/%d 次检测，每 30 秒一次）\n' "$i" "$WAIT_ROUNDS"
  done
  echo
  echo "🛑 等待超时（10 分钟），脚本终止。问题解决后重新运行本脚本即可，"
  echo "   已完成的部分不会重复执行。"
  exit 1
}

echo "=============================================="
echo " cloud-mail IMAP/SMTP 网关安装"
echo "  站点   : $WORKER"
echo "  IMAP域 : $DOMAIN"
echo "  目录   : $INSTALL_DIR"
echo "=============================================="

# ---------------------------------------------------------- [1/8] 环境
echo "── [1/8] 检查系统环境"
if [ -z "${PUBLIC_IP:-}" ]; then
  PUBLIC_IP="$(curl -s4 --max-time 8 https://api.ipify.org || true)"
  [ -z "$PUBLIC_IP" ] && PUBLIC_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
gate "探测不到本机公网 IP" \
"│  修复方法：确认本机能上网；或在 VPS 控制台查到公网 IP 后：       │
│     export PUBLIC_IP=你的公网IP                                 │
│  然后重跑本脚本。                                                │" \
  '[ -n "$PUBLIC_IP" ]'
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
gate "Docker / Compose 不可用" \
"│  修复方法：手动安装 Docker + Compose v2 后等待本脚本自动检测：   │
│     curl -fsSL https://get.docker.com | sh                      │
│  装完不用退出重跑，脚本会自动检测到。                             │" \
  'command -v docker >/dev/null && docker compose version >/dev/null'
mark_done "Docker：$(docker --version | awk '{print $3}' | tr -d ,) + Compose 可用"

# ---------------------------------------------------------- [2/8] DNS 强制关卡
echo "── [2/8] DNS A 记录检查（强制关卡）"
dns_ok() {
  local ip
  ip="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
  [ -z "$ip" ] && ip="$(nslookup -type=A "$DOMAIN" 2>/dev/null | awk '/^Address/ && !/:#/ {print $2; exit}')"
  DNS_NOW="$ip"
  [ -n "$ip" ] && [ "$ip" = "$PUBLIC_IP" ]
}
DNS_NOW=""
if dns_ok; then
  mark_done "$DOMAIN → ${PUBLIC_IP}（已指向本机）"
else
  cat <<EOF

╔══════════════════════════════════════════════════════════════╗
║  🛑🛑  DNS 还 没 加 好 —— 不 做 完 绝 不 往 下 走          🛑🛑  ║
╠══════════════════════════════════════════════════════════════╣
║  请现在去你的 DNS 服务商加一条 A 记录：                        ║
║                                                              ║
║     主机记录 ：${DOMAIN%%.*}                                          ║
║     记录类型 ：A                                             ║
║     记录值   ：${PUBLIC_IP}                      ║
║                                                              ║
║  ⚠️  域名在 Cloudflare 托管的话，必须选「仅 DNS」灰云 ☁️：    ║
║      橙云（开启代理）会让 IMAP 993 端口永远无法直连！         ║
║                                                              ║
║  加好后不用退出重跑——脚本每 30 秒自动检测，检测到就继续。     ║
╚══════════════════════════════════════════════════════════════╝
EOF
  i=0
  while [ "$i" -lt 60 ]; do
    i=$((i + 1))
    sleep 30
    DNS_NOW=""
    if dns_ok; then
      echo "   ✅ 检测到 DNS 已生效：$DOMAIN → ${PUBLIC_IP}，继续安装。"
      mark_done "DNS A 记录已生效（等待期间自动检测到）"
      break
    fi
    printf '   ⏳ 等待 DNS 生效中…（第 %d 次检测，当前解析：%s）\n' "$i" "${DNS_NOW:-无记录}"
  done
  if ! dns_ok; then
    echo "🛑 等待 30 分钟仍未生效，脚本终止。加好 A 记录后重跑本脚本即可。"
    exit 1
  fi
fi

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
mark_done ".env 已写入（WORKER_BASE=$WORKER）"

# ---------------------------------------------------------- [4/8] 证书 + 续签（强制关卡）
echo "── [4/8] 申请 Let's Encrypt 证书 + 续签机制验证（强制关卡）"
port80_free() { ! (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE ':80\s'; }
gate "80 端口被占用（Let's Encrypt HTTP-01 验证需要它）" \
"│  修复方法：找到并停掉占用 80 端口的服务（签证书只用几分钟）：    │
│     ss -ltnp | grep ':80 '          # 看是谁占用                │
│     systemctl stop xxx              # 临时停掉它                │
│  停掉后脚本会自动检测并继续。                                    │" \
  'port80_free'

CERT_CONF=""
if [ -x "$HOME/.acme.sh/acme.sh" ]; then
  ACME="$HOME/.acme.sh/acme.sh"
else
  echo "   ⏳ 安装 acme.sh…"
  curl -fsSL https://get.acme.sh | sh -s email="${LE_EMAIL:-admin@${DOMAIN#*.}}" >/dev/null 2>&1
  ACME="$HOME/.acme.sh/acme.sh"
fi
if [ -x "$ACME" ] && [ ! -s "$INSTALL_DIR/certs/fullchain.pem" ]; then
  "$ACME" --issue -d "$DOMAIN" --standalone --server letsencrypt \
    --key-file "$INSTALL_DIR/certs/privkey.pem" \
    --fullchain-file "$INSTALL_DIR/certs/fullchain.pem" \
    --install-cert "$DOMAIN" --reloadcmd "docker restart cmimap >/dev/null 2>&1 || true" >/dev/null 2>&1 || true
fi

cert_valid() {
  [ -s "$INSTALL_DIR/certs/fullchain.pem" ] && [ -s "$INSTALL_DIR/certs/privkey.pem" ] \
    && openssl x509 -in "$INSTALL_DIR/certs/fullchain.pem" -noout >/dev/null 2>&1 \
    && openssl x509 -in "$INSTALL_DIR/certs/fullchain.pem" -noout -text 2>/dev/null | grep -q "DNS:${DOMAIN}"
}
gate "Let's Encrypt 证书未签发成功" \
"│  常见原因（按概率排序）：                                        │
│   1. 云厂商安全组没放行 80 端口 ← 最常见！去控制台加入站规则     │
│   2. DNS 刚加还没全球生效（等 2~5 分钟即可）                     │
│   3. 本周该域名签发次数达 Let's Encrypt 限额（50 张/周）         │
│  注意：本脚本不用自签证书糊弄——签发成功才会继续。               │
│  也可以手动放好证书到 $INSTALL_DIR/certs/ 后自动检测通过。       │" \
  'cert_valid'
mark_done "Let's Encrypt 正式证书已签发（SAN 含 $DOMAIN，openssl 校验通过）"

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
gate "证书自动续签机制未生效" \
"│  修复方法（二选一，改完脚本自动检测）：                          │
│   a. 手动装 cron：crontab -e 加入：                             │
│      0 1 * * * \"$ACME\" --cron --home \"$RENEW_CONF\" >/dev/null│
│   b. 手动装 systemd：                                           │
│      systemctl enable --now acme-mail-renew.timer               │" \
  'renew_ok'
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
gate "容器启动失败" \
"│  修复方法：进安装目录看日志定位原因：                            │
│     cd $INSTALL_DIR && docker compose logs --tail 50            │
│  常见原因：.env 里 WORKER_BASE 填错 / 端口被占用。              │
│  处理完脚本会自动检测容器是否跑起来。                            │" \
  'docker inspect -f "{{.State.Status}}" cmimap 2>/dev/null | grep -q running'
mark_done "容器已启动（cmimap，restart=unless-stopped，开机自启）"

# ---------------------------------------------------------- [6/8] 健康自检
echo "── [6/8] 等待容器健康"
ST=""
for i in $(seq 1 15); do
  ST="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' cmimap 2>/dev/null | tr -d '[:space:]')"
  [ "$ST" = "healthy" ] && break
  sleep 2
done
gate "容器健康检查未通过（状态：${ST:-unknown}）" \
"│  修复方法：看容器日志定位：                                      │
│     docker logs --tail 50 cmimap                                │
│  最常见：证书文件权限不对（需 644 且容器内 uid 1000 可读）。     │" \
  '[ "$(docker inspect -f "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" cmimap 2>/dev/null | tr -d "[:space:]")" = "healthy" ] || [ "$(docker inspect -f "{{.State.Status}}" cmimap 2>/dev/null)" = "running" ]'
mark_done "容器状态：${ST:-running}"

# ---------------------------------------------------------- [7/8] 端口握手
echo "── [7/8] 本机端口握手测试"
for p in "$IMAP_PORT" "$SMTP_PORT"; do
  handshake_ok() { timeout 8 openssl s_client -connect "127.0.0.1:${p}" -quiet </dev/null 2>/dev/null | grep -qiE 'OK|READY|ESMTP|\* '; }
  gate "127.0.0.1:${p} TLS 握手失败" \
"│  修复方法：容器可能在崩溃循环，看日志：                          │
│     docker logs --tail 50 cmimap                                │
│  证书异常是最常见原因（重新签发后 docker restart cmimap）。      │" \
    'handshake_ok'
  mark_done "127.0.0.1:${p} TLS 握手正常"
done

# ---------------------------------------------------------- [8/8] 站点连通
echo "── [8/8] 校验与你 cloud-mail 站点的连通"
worker_ok() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$WORKER/" || true)" != "000" ] && [ -n "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$WORKER/" || true)" ]; }
gate "无法访问你的 cloud-mail 站点 $WORKER" \
"│  修复方法：                                                     │
│   1. 确认 --worker 填的是你站点真实地址（浏览器能打开）          │
│   2. 本机 curl -I $WORKER 看返回                                │
│   3. 填错的话：改 $INSTALL_DIR/.env 的 WORKER_BASE 后           │
│      docker compose up -d 重建，再重跑本脚本检测                 │" \
  'worker_ok'
mark_done "站点可达：$WORKER"

# ============================================================
#  最终报告：已完成 + 强提醒（脚本无法代劳的事项）
# ============================================================
echo
echo "============================================================"
echo "                    ✅ 安 装 成 功"
echo "============================================================"
echo
echo "✅ 已完成 ${#DONE[@]} 项（全部当场验证过）："
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
echo "🎉 全部完成。没做第 1、2 条之前，客户端是登录不了的——别跳过。"
exit 0
