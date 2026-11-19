# cloud-mail IMAP / SMTP 网关

让 Apple Mail、Outlook、Foxmail、Thunderbird、手机自带邮件 App 通过标准 **IMAP 993 / SMTP 2465** 收发你的 cloud-mail（Cloudflare Workers 版）邮箱。

- **邮件数据一份不动**：正文与附件仍在 Cloudflare D1 / R2，网关只通过现有 API 读写
- **随时可停**：`sudo systemctl stop cmimap`（或 `docker compose stop`）后 webmail 收发完全不受影响
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

### 第 1 步：在 VPS 上跑安装脚本

```bash
sudo bash install.sh --worker https://你的站点 --domain imap.你的域名
```

脚本会自动：装 Docker（缺则装）→ 校验 DNS（没加好会**停下来等你**，自动轮询）→ 申请 Let's Encrypt 证书（签发失败会停下，不用自签兜底）→ 拉镜像起容器 → 健康自检 → 打印客户端参数与「还没做的事」清单。

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
| `install.sh` | 一键安装（DNS/证书强制关卡 + 完成后强提醒） |
| `scripts/verify-*.mjs` | 构建期回归门禁（212 项断言，Dockerfile 内强制执行） |
| `docs/examples/` | 证书续签 / systemd 参考（1Panel 用户可直接参考） |

## 本地自检

```bash
npm run verify   # 212 项断言，不需要网络
npm run smoke -- --port 993 --user you@example.com --pass <应用密码> --folder INBOX
```

## 端口说明（为什么没有 465 / 587）

实测部分国内链路对 465 直接 RST、587 收不到 banner，因此默认只挂 **2465**。
代码仍支持按需挂回：`SMTP_PORT` / `SMTP_PORT_ALT` / `SMTP_PORT_STARTTLS` 写 `0` 或留空即关闭。

## License

[MIT](LICENSE)
