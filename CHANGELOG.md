# 更新日志

镜像标签与本节版本号一一对应：`ghcr.io/kxx4988/cloud-mail-imap:v0.2.33`

> **发布规范**：每个 tag 的说明必须写清「这版做了什么」，禁止只写版本号。
> 格式为 `vX.Y.Z — 一句话摘要` + 空行 + 变更要点列表；摘要要能让人只翻 GitHub Tags 页面就看懂。
> 同时在本文件追加同一条目，两者内容一致。

## v0.2.33 — 新增网关状态心跳上报 + 安装脚本关卡加固

配合主程序「网关状态」：站点跑在 Workers 无法主动探测 993 / 2465，改由网关定时上报。
主程序侧生成的命令已带 `--hb-url` / `--hb-key`，v0.2.32 照命令装会「未知参数 exit 2」，本版补齐。

**新增心跳上报**：

- `src/heartbeat.js`：启动即上报一次，之后每 60 分钟；POST `${HB_URL}/api/imap/heartbeat`，
  带 `key / domain / version / certDays / uptime / ts`
- **只认 body 的 `code === 200`**：站点侧业务 401 的 HTTP 状态仍是 200（`{code:401}`），
  只看 HTTP status 会把密钥错误误判为成功
- `certDays` 用 Node 内置 `X509Certificate` 读 `/certs/fullchain.pem`，容器不依赖 openssl CLI
- 密钥只出现在请求 body，不写进镜像、不写进日志
- 心跳是旁路：任何失败只打 warn 日志，绝不影响 IMAP / SMTP；未配置 `HB_URL` / `HB_KEY` 时整个模块跳过
- `install.sh` 支持 `--hb-url` / `--hb-key`；`.env` 保留已有心跳配置（重跑不抹掉）；
  compose 透传 `HB_URL` / `HB_KEY` / `HB_DOMAIN` / `HB_INTERVAL_MS`
- `scripts/verify-heartbeat.mjs` 23 项自检；`package.json` 的 `verify` 补齐此前漏掉的 `verify-append`
  （原先 `npm run verify` 只跑 212 项），门禁合计 **245 → 268**

**安装脚本关卡加固（关卡机制不变：一步不过就不进下一步、原因说清楚）**：

- 公网 IP：`hostname -I` 常返回内网地址，拿它去要求 DNS 指向会永远过不去 →
  新增公网 / 私网判定，识别后提示 `export PUBLIC_IP=真实公网IP`
- 续签验证：原先只看 timer enabled，acme.sh 没装成功时会出现「通过但每天什么都没干」的假阳性 →
  新增 `[ -x "$ACME" ]`，且不再创建指向不存在二进制的 timer
- 站点连通：原先只判「非 000」，填成任意能响应的网址（403 / 404 / 500）也过关 → 改为只认 2xx / 3xx
- 遗留坏证书：`issue_cert` 会跳过已有 fullchain 导致卡 20 分钟 → 诊断明确提示删除无效证书重签，脚本不代删
- `.env`：原先每次重跑全量覆盖，会抹掉心跳配置 → 保留已有 `HB_*` 值

**关卡文案（按「统一脚本路径」原则）**：

- 80 端口关改为**只提示、不自动停服务**：明说脚本不动你的服务与防火墙，
  给出「临时停 → 签发 → 立刻拉起」成对命令、不想中断就走手动安装、DNS-01 当前不支持
- 证书关标题改「未检测到由本脚本签发的有效证书」，列明四类原因，删掉「手动放好证书也能过」的误导
- 续签关注明「只验证 acme.sh 续签，面板 / 外部证书不在此列」
- 结尾强提醒补第 3 条「回站点保存网关域名」；证书续签不再说「无需人工干预」，改为建议验证一次
- README 明确声明：脚本只支持自动签发；自带 / 面板 / 自签证书请用手动安装并自行续签
- 心跳启用时结尾报告提示可在站点「系统设置 → 网关状态」查看

**其它**：`docs/ROADMAP.md` 第 1、2 项标记已实现；证书告警由站点侧用上报的 `certDays` 承接，
网关不再单独引入 TG 通知配置。

## v0.2.32 — 文档：补上「已装好的怎么升级」

此前只有从零安装的步骤，装完之后想升新版没有任何说明，只能靠猜。
而重跑 `install.sh` 会重走 8 道校验（DNS / 80 端口 / 签证书），既慢又可能重复申请证书。

**新增**：

- README 顶部项目说明补一条「**随时可升级**」：一句话给出换版命令、说明证书与数据不动、回滚方式，并链到升级章节
- README 新增「升级到新版本」章节：`docker compose pull` → `up -d --force-recreate` → `image prune` 三步
- 说明为何必须 `--force-recreate`：只 `up -d` 时 Compose 认为容器配置未变，可能仍是旧镜像在跑
- 明确列出升级**不影响**的东西：`certs/`、`data/`、`.env`、云端邮件数据
- 给出验证方式：容器 `healthy` + 镜像 `CreatedAt`
- 给出**回滚到指定版本**的写法（每个 tag 都有同名镜像）
- 生产环境建议固定版本号，避免 `:latest` 漂移

代码与镜像内容同 v0.2.31，本版仅文档。

## v0.2.31 — CI 修正：latest 只由最高版本 tag 更新

**问题**：workflow 原来给每个 `v*` tag 都打 `latest`，重建历史 tag（如补写说明后 force push）
会把 `latest` 覆盖成旧镜像。本次实测 `latest` 一度指向 `v0.2.27` 的镜像。

**修复**：

- workflow 新增「判断是否为最高版本 tag」步骤：用 `git tag -l 'v*' --sort=-v:refname` 取最高版本，
  仅当当前 tag 与之相等时才更新 `latest`
- `checkout` 改为 `fetch-depth: 0`（需要全部 tag 才能比较）
- 重建历史 tag 只更新自己的 tag，不动 `latest`
- 镜像内容同 v0.2.30

> 操作提示：以后若要修改历史 tag 说明，force push 后不会再影响 `latest`，无需额外补推最新 tag。

## v0.2.30 — 文档：版本历史表与 tag 说明规范

用户反馈「Tags 页面只写个版本号太怪异，得说明做了啥」。本版把发布可读性补齐：

- **回填历史 tag 说明**：v0.2.27 / v0.2.28 / v0.2.29 三个 tag 的说明由单行版本号
  重写为「一句话摘要 + 变更要点」，指向的 commit 不变
- **README 新增版本历史表**：每版一行摘要，当前版本置顶标注
- **README + 本 CHANGELOG 增加发布规范**：tag 说明禁止只写版本号，
  须为 `vX.Y.Z — 摘要` + 要点列表，并同步本文件
- 代码与镜像内容同 v0.2.29，本版仅文档与发布元数据

## v0.2.29 — 安装脚本交互重做

**install.sh 体验改造（核心：不让你无提示地干等，也不允许跳过）**

- 每轮输出时间轴：`已等待 mm:ss / 上限 mm:ss ｜ 第 N 次未通过`
- 支持 **按回车立即重新检测**（`curl | bash` 下用 `/dev/tty` 抢回键盘输入；抢不到自动降级纯轮询）
- 轮询节奏：前 2 分钟 15 秒/次，之后 30 秒/次；DNS 关卡单轮上限 30 分钟，证书 20 分钟
- 连续 3 次不通过自动打印诊断：
  - DNS：本机与 1.1.1.1 / 8.8.8.8 的实际解析值、与公网 IP 的差异原因（主机名错/旧 IP/橙云代理）
  - 证书：`acme.sh` 日志尾巴，或已有证书的 SAN 与期望域名
  - 容器：`State.Status` + 最近 12 行日志
  - 端口：监听状态 + 容器状态 + 日志尾巴
  - 站点：`curl -I` 响应头
- 到达单轮上限**不再 `exit 1`**：提示「按回车继续再等一轮 / Ctrl+C 退出」，已完成步骤不会重复
- 放弃自签证书兜底（此前已生效，本次仅强化诊断文案）
- 结尾报告增加总耗时，并保留「脚本无法代劳」强提醒（安全组放行 993/2465、站点生成应用密码）

**文档**：README 新增「脚本交互」表格；本 CHANGELOG 建立。

## v0.2.28 — 文档修正

- 安装命令改为 `curl ... | sudo bash -s --` 一行式（与网页端生成的一致，无需先下源码）
- 回归门禁断言数 212 → 245（实际数量）
- 停止命令 `systemctl stop cmimap` → `docker compose stop`（容器无 systemd unit）

## v0.2.27 — 首次开源发布

- 公开仓库与 GHCR 镜像首发；版本 0.2.27 对应线上长期运行的网关能力
- IMAP 993 / SMTP 2465（隐式 TLS）；Apple Mail / Outlook / Foxmail / Thunderbird 兼容
- 命令支持：LOGIN / AUTHENTICATE PLAIN、LIST / SELECT / STATUS、FETCH（含 `BODY[...]` 各段与部分取）、SEARCH（含 CHARSET）、STORE、EXPUNGE、COPY / MOVE / APPEND
- `CREATE / DELETE / RENAME / SUBSCRIBE` 明确回 `NO`（站内只有固定系统文件夹，不谎报能力）
- 构建期 245 项回归断言在 Dockerfile 内强制执行，断言不过就不出镜像
