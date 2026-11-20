# [S37] cloud-mail IMAP/SMTP 网关
# P2 起安装 npm 依赖（@rafters/mail-imap + server 运行时）；纯 JS 依赖，arm64 免编译。
FROM node:20-alpine

ENV NODE_ENV=production \
    TZ=Asia/Shanghai

WORKDIR /app

# 先装依赖（层缓存友好）
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# 给 @rafters/mail-imap 打运行时补丁（BODYSTRUCTURE 真实 size / BODY[TEXT] 与 HEADER.FIELDS 按 RFC 切分）
COPY patches ./patches
RUN node patches/apply-imap-patches.mjs

COPY src ./src

# 构建期结构自检（v0.2.10 起）：BODYSTRUCTURE 与 RFC822 原文由同一棵 part 树推导，
# 字段数 / 段号 / 字节数任何一项对不上就直接让构建失败，不把坏镜像推上线。
# v0.2.15 起加 verify-session：起一个明文内存 server 用真实 socket 打 literal / NOOP / IDLE。
# v0.2.17 起加 verify-to：已发送邮件的 To（recipient 兜底）与 RFC822.SIZE 一致性。
# v0.2.18 起加 verify-auth：AUTHENTICATE PLAIN 与 SEARCH CHARSET（第三方客户端兼容）。
# v0.2.20 起加 verify-append：APPEND 去重 + COPY/MOVE 开关（发信后存副本不再弹窗）。
COPY scripts ./scripts
RUN node scripts/verify-mime.mjs && node scripts/verify-sections.mjs && node scripts/verify-search.mjs && node scripts/verify-session.mjs && node scripts/verify-to.mjs && node scripts/verify-auth.mjs && node scripts/verify-append.mjs && node scripts/verify-heartbeat.mjs

# 非 root 运行（内置 node 用户 uid 1000）；证书以 644 + 只读挂载传入
USER node

EXPOSE 993 2465

HEALTHCHECK --interval=30s --timeout=6s --start-period=10s --retries=3 \
  CMD node -e "const t=require('node:tls');const s=t.connect({host:'127.0.0.1',port:Number(process.env.IMAP_PORT||993),rejectUnauthorized:false},()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(5000,()=>process.exit(1));"

CMD ["node", "src/index.js"]
