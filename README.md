# cloud-mail IMAP / SMTP 网关

让 Apple Mail、Outlook、Foxmail、Thunderbird、手机自带邮件 App 通过标准 **IMAP 993 / SMTP 2465** 收发你的 cloud-mail（Cloudflare Workers 版）邮箱。

- **邮件数据一份不动**：正文与附件仍在 Cloudflare D1 / R2，网关只通过现有 API 读写
- **随时可停**：`cd /opt/cloud-mail-imap && docker compose stop` 后 webmail 收发完全不受影响
- **不需要 25 端口、不接管 MX**：不影响现有收信链路，只多开 993 / 2465 两个口
- **账号级强隔离**：每个用户只能访问自己的邮箱；发件身份必须等于认证邮箱

## 快速开始（3 步）

### 第 0 步（人工，无法代劳）：加 DNS A 记录

| 项 | 值 |
|---|---|
| 主机记录 | `imap`（即 `imap.你的域名`） |
| 记录类型 | `A` |
| 记录值 | 你 VPS 的公网 IP |
| Cloudflare | **必须「仅 DNS」灰云 ☁️** —— 橙云代理会让 993 永远连不上 |

### 第 1 步：在 VPS 上跑安装脚本（一条命令，无需下源码）

```bash
curl -fsSL https://raw.githubusercontent.com/kxx4988/cloud-mail-imap/main/install.sh \
  | sudo bash -s -- --worker https://你的站点 --domain imap.你的域名
```

> 由 cloud-mail 网页端「设置 → 第三方客户端」生成的命令已自动填好这两个参数，复制粘贴即可。

脚本会自动：装 Docker（缺则装）→ 校验 DNS → 申请 Let's Encrypt 证书 → 验证续签机制 → 拉镜像起容器 → 健康自检 → 端口握手 → 站点连通 → 打印客户端参数与「还没做的事」清单。

**脚本交互（v0.2.29 起，不让你无提示地干等）**：

| 场景 | 脚本行为 |
|---|---|
| 任一关卡未通过 | 弹「安装已停下」醒目框 + 该步修复指引，**不继续、不跳过** |
| 等待期间 | 每轮显示 `已等待 mm:ss / 上限 mm:ss ｜ 第 N 次未通过` |
| 想立刻重试 | 任何时刻按 **回车** = 立即重新检测（不用等到下一轮） |
| 轮询节奏 | 前 2 分钟 **15 秒/次**，之后 **30 秒/次**（DNS 生效通常很快，早发现早继续） |
| 连续 3 次不过 | 自动打印诊断：DNS 实际解析值 / 证书 SAN / 容器状态 + 日志尾巴 / 端口监听 / curl 响应头 |
| DNS 本机缓存 | 本机查不到时自动改用 1.1.1.1 / 8.8.8.8 直查兜底（避免"明明加了却一直不过"） |
| 到达单轮上限 | **不退出、不跳过**：提示可继续再等一轮，`Ctrl+C` 才退出（重跑不会重复已完成步骤） |
| 非交互环境 | 自动降级为纯轮询（不需要按回车），不会卡住等输入 |

单轮上限：DNS 30 分钟，证书 20 分钟，其余 5~10 分钟（可用 `MAX_WAIT` / `DNS_MAX_WAIT` 环境变量覆盖）。

### 第 2 步：生成应用密码

登录你的 cloud-mail 站点 → **个人设置 → 第三方客户端** → 生成 16 位应用密码。
（客户端密码栏填应用密码，不是登录密码。需要 mail-worker 侧已包含 IMAP 应用密码功能。）

### 第 3 步：客户端配置

```
收件 IMAP：imap.你的域名   端口 993    加密 SSL/TLS
发件 SMTP：imap.你的域名   端口 2465   加密 SSL/TLS
用户名    ：你的完整邮箱地址
密码      ：应用密码
```

> ⚠️ 安全组/防火墙放行 **80（签证书）**、**993、2465**，云厂商控制台和系统内防火墙都要确认。

## 手动安装（不用脚本）

```bash
git clone https://github.com/kxx4988/cloud-mail-imap.git
cd cloud-mail-imap
cp .env.example .env && vi .env      # WORKER_BASE=https://你的站点
mkdir certs                          # 放入 fullchain.pem / privkey.pem（正式证书）
docker compose up -d --build         # 或 docker compose up -d 直接用 GHCR 镜像
```

镜像：`ghcr.io/kxx4988/cloud-mail-imap:latest`（打 tag 自动构建）。

## 升级到新版本

已经部署好的机器**不要用重跑 `install.sh` 的方式升级** —— 那会重走 8 道校验（DNS / 80 端口 / 签证书），既慢，还可能重复申请证书。正确做法是替换镜像：

```bash
cd /opt/cloud-mail-imap          # 手动安装的换成你的实际目录
docker compose pull              # 拉取新镜像
docker compose up -d --force-recreate
docker image prune -f            # 可选：清理旧镜像
```

`--force-recreate` 不能省：只执行 `up -d` 时 Compose 认为容器配置没变，可能不重建，结果还是旧镜像在跑。

**升级不会碰这些东西**：

| 项 | 原因 |
|---|---|
| `certs/` 证书与私钥 | 宿主机目录挂载（`./certs:/certs:ro`），容器重建不动文件 |
| `data/` | 同上（`./data:/data`） |
| `.env`（`WORKER_BASE`、端口） | 宿主机文件，重建时只读取 |
| 邮件正文与附件 | 存 Cloudflare D1 / R2，网关本身不落库 |

**确认真的升上去了**：

```bash
docker ps --filter name=cmimap --format '{{.Status}}'                       # Up ... (healthy) 才算好
docker images ghcr.io/kxx4988/cloud-mail-imap --format '{{.Tag}}  {{.CreatedAt}}'
```

镜像没有内置版本号标签，看 `latest` 那行的 `CreatedAt` 是不是刚才即可；再用客户端连一次 993 / 2465 收发一封最稳。

**回滚到指定版本**：每个发行的 tag 都有对应镜像（`v0.2.31`、`v0.2.30` …），把 compose 里的镜像换成具体版本再重建：

```bash
sed -i 's|cloud-mail-imap:latest|cloud-mail-imap:v0.2.31|' docker-compose.yml
docker compose up -d --force-recreate
```

> 生产环境建议**直接固定版本**：把 `docker-compose.yml` 的 `image:` 写成 `:v0.2.32`，以后升级改成新版本号再 `up -d`。这样任何一次 `pull` 都不会带来非预期的变更。

## 命令支持

| 命令 | 状态 | 备注 |
|---|---|---|
| LOGIN / AUTHENTICATE PLAIN / LOGOUT / CAPABILITY / NOOP / IDLE | ✅ | 应用密码登录，`LOGIN` 与 SASL `AUTHENTICATE PLAIN` 双通道；**literal 完整支持**（同步 `{n}` 回 `+`、非同步 `{n+}` 不回，按字节计数，中文搜索可走） |
| LIST / LSUB / STATUS / SELECT / EXAMINE | ✅ | 四个系统文件夹：INBOX / Sent / Trash / Junk |
| FETCH / UID FETCH / SEARCH / UID SEARCH | ✅ | 含 `BODY[]`、`BODY[TEXT]`、`BODY[n]`、`BODY[n.MIME]`、`BODY[n.HEADER.FIELDS(.NOT)]`、`<start.count>` 部分取 |
| STORE / UID STORE（已读 / 星标 / 删除） | ✅ | 删除走站内软删除（进回收站）；FLAGS 只声明 `\Seen \Flagged \Deleted`（站内真实支持的三个） |
| EXPUNGE / UID EXPUNGE / CLOSE / UNSELECT | ✅ | UID EXPUNGE 支持区间集合 |
| NAMESPACE / ID / CHECK | ✅ | CAPABILITY 里声明了就必须能应答 |
| CREATE / DELETE / RENAME / SUBSCRIBE | ⛔ `NO` | 站内只有固定系统文件夹，不谎报能力 |
| COPY / MOVE / APPEND | ✅ | 回收站 / 垃圾邮件 = 站内软删除与标垃圾；APPEND 到已发送做去重应答；其它目标回 `NO` |
| SMTP（2465 隐式 TLS） | ✅ | AUTH **PLAIN + LOGIN** 双机制；MAIL FROM 必须等于认证邮箱；DATA 转调 `/api/email/send`。465 / 587 已停用 |

## 架构

```
邮件客户端 ── IMAP 993 / SMTP 2465 (TLS) ──▶ 本网关 (Docker, Node 20)
                                             │  HTTPS（应用密码换短时 token）
                                             ▼
                                   cloud-mail Worker (Cloudflare)
                                   D1（邮件）/ R2（附件）/ Resend（外发）
```

`src/mime.js` 是唯一的结构事实源：一棵 part 树同时产出 `BODYSTRUCTURE` 与 RFC822 原文，
两者不可能漂移（历史上每次「正文空白 / PDF 乱码」都是这两者算得不一样）。

| 路径 | 说明 |
|---|---|
| `src/index.js` | 进程入口：993 IMAP + 2465 隐式 TLS SMTP |
| `src/adapters.js` | IMAP 适配器（文件夹 / 邮件 / 段 / SEARCH 求值） |
| `src/mime.js` | part 树 → BODYSTRUCTURE + RFC822 原文 |
| `src/sections.js` | `BODY[...]` 段定位（多层嵌套与部分取） |
| `src/smtp.js` | SMTP 会话与发信 |
| `src/worker-client.js` | cloud-mail Worker API 客户端（token 缓存 / 三层缓存） |
| `patches/apply-imap-patches.mjs` | 对 `@rafters/mail-imap` 的 22 组运行时补丁（构建时幂等执行） |
| `install.sh` | 一键安装（强制关卡 + 时间轴 + 按回车立即检测 + 诊断 + 完成后强提醒） |
| `scripts/verify-*.mjs` | 构建期回归门禁（245 项断言，Dockerfile 内强制执行） |
| `docs/examples/` | 证书续签 / systemd 参考（1Panel 用户可直接参考） |

## 本地自检

```bash
npm run verify   # 245 项断言，不需要网络
npm run smoke -- --port 993 --user you@example.com --pass <应用密码> --folder INBOX
```

## 端口说明（为什么没有 465 / 587）

实测部分国内链路对 465 直接 RST、587 收不到 banner，因此默认只挂 **2465**。
代码仍支持按需挂回：`SMTP_PORT` / `SMTP_PORT_ALT` / `SMTP_PORT_STARTTLS` 写 `0` 或留空即关闭。

## 版本与更新

当前镜像 `ghcr.io/kxx4988/cloud-mail-imap:v0.2.32`

| 版本 | 做了什么 |
|---|---|
| **v0.2.32**（当前） | 文档：新增「升级到新版本」（三步替换镜像、为何要 `--force-recreate`、回滚与固定版本建议） |
| v0.2.31 | CI 修正：`latest` 只由版本号最高的 tag 更新，重建历史 tag 不再污染 latest |
| v0.2.30 | 文档：新增版本历史表与发布规范，回填历史 tag 的完整变更说明 |
| v0.2.29 | 安装脚本交互重做：时间轴进度、按回车立即检测、连续失败自动诊断、到上限不退出 |
| v0.2.28 | 文档修正：安装命令改一行式、断言数 212→245、停止命令改 `docker compose stop` |
| v0.2.27 | 首次开源发布：IMAP 993 / SMTP 2465 网关、245 项断言门禁、主流客户端兼容 |

逐版本完整变更见 [CHANGELOG.md](CHANGELOG.md)。

### 发布规范

打 tag 时说明**必须写清这版做了什么**，禁止只写版本号：

- 格式：`vX.Y.Z — 一句话摘要` + 空行 + 变更要点列表
- 摘要要能让人只翻 Tags 页面就知道这版改了什么
- 同步在本 CHANGELOG 追加同一条目

```bash
git tag -a v0.2.30 -F /path/to/notes.txt   # 用文件写多行说明，别用 -m 挤一行
git push origin v0.2.30
```

## License

[MIT](LICENSE)
