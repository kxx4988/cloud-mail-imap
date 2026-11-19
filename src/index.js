/**
 * [S37] cloud-mail IMAP / SMTP 网关 —— P4
 *
 * IMAP 993：@rafters/mail-imap-server（协议层）+ 自研适配器（cloud-mail API）
 * SMTP 2465：隐式 TLS，AUTH（应用密码）+ DATA 转调 /api/email/send
 *   465 / 587 已在 v0.2.16 关闭（国内链路 ECONNRESET / 吞 banner），env 写 0 或留空即可关
 */
'use strict';

import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { createImapServer } from '@rafters/mail-imap-server';
import { authAdapter, mailboxAdapter, messageAdapter, extensionAdapter } from './adapters.js';
import { createSmtpStarter } from './smtp.js';
import { login, authedRequest } from './worker-client.js';

// worker-client 的 login / authedRequest 供 SMTP AUTH 与发信直接复用
const workerClient = { login, authedRequest };

const CERT_DIR = process.env.CERT_DIR || '/certs';
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const HOST = process.env.BIND_HOST || '0.0.0.0';

function loadTlsOptions() {
  const certFile = process.env.CERT_FILE || path.join(CERT_DIR, 'fullchain.pem');
  const keyFile = process.env.KEY_FILE || path.join(CERT_DIR, 'privkey.pem');
  return {
    key: fs.readFileSync(keyFile),
    cert: fs.readFileSync(certFile),
    minVersion: 'TLSv1.2',
    honorCipherOrder: true,
  };
}

let tlsOptions;
try {
  tlsOptions = loadTlsOptions();
} catch (err) {
  console.error(`[fatal] 证书读取失败：${err.message}`);
  console.error(`[fatal] 期望目录 ${CERT_DIR} 下存在 fullchain.pem 与 privkey.pem`);
  process.exit(1);
}

/* ---------------------------------------------------------------- IMAP 993 */

// mailboxId = 邮箱地址本身
const imap = createImapServer({
  adapters: {
    authAdapter,
    mailboxAdapter,
    messageAdapter,
    // [v0.2.20] APPEND 支持：Apple Mail 发信后存副本不再弹 "APPEND not supported"
    extensionAdapter,
  },
  tls: tlsOptions,
  host: HOST,
  port: IMAP_PORT,
  maxConnections: 20,
  sessionTimeoutMs: 30 * 60_000,
  async resolveMailboxId(email) {
    return String(email).toLowerCase();
  },
});

imap.listen().then(() => {
  console.log(`[imap] listening on ${HOST}:${IMAP_PORT} (implicit TLS, rafters/mail-imap)`);
}).catch((err) => {
  console.error(`[imap] 启动失败：${err.message}`);
  process.exit(1);
});

/* ---------------------------------------------------------------- SMTP 入口 */

// v0.2.16：只保留 2465 一个隐式 TLS 入口。
// 实测 465 被链路直接 ECONNRESET、587 能连上但收不到 banner（数据被吞），Oracle 放行也无效，
// 两者留着只是把失效口暴露给扫描器，容易让客户端配错。
// env 里写 "0" 或留空 = 该入口不启用；不写 = 沿用旧默认（465 / 2465 / 587），便于以后按需挂回。
const envPort = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const SMTP_IMPLICIT_PORTS = [...new Set(
  [envPort('SMTP_PORT', 465), envPort('SMTP_PORT_ALT', 2465)].filter((p) => p > 0),
)];
const SMTP_STARTTLS_PORT = envPort('SMTP_PORT_STARTTLS', 587);
if (!SMTP_IMPLICIT_PORTS.length && !SMTP_STARTTLS_PORT) {
  console.error('[fatal] 没有任何 SMTP 入口启用（SMTP_PORT / SMTP_PORT_ALT / SMTP_PORT_STARTTLS 全为 0）');
  process.exit(1);
}

const smtp = createSmtpStarter({ tlsOptions, workerClient });
const smtpServers = [];

for (const p of SMTP_IMPLICIT_PORTS) {
  const s = net.createServer((socket) => {
    // 隐式 TLS：连接进来先包 TLSSocket，握手完成起会话
    const secure = new tls.TLSSocket(socket, {
      isServer: true,
      secureContext: tls.createSecureContext(tlsOptions),
      server: s,
    });
    secure.setTimeout(15000, () => secure.destroy(new Error('TLS handshake timeout')));
    secure.once('error', () => { try { secure.destroy(); } catch (e) { /* 忽略 */ } });
    secure.once('secure', () => {
      secure.setTimeout(0);
      smtp.startSecure(secure);
    });
  });
  s.on('error', (err) => {
    console.error(`[smtp] 端口 ${p} 监听失败：${err.message}`);
    process.exit(1);
  });
  s.listen(p, HOST, () => {
    console.log(`[smtp] listening on ${HOST}:${p} (implicit TLS, AUTH → /api/email/send)`);
  });
  smtpServers.push(s);
}

if (SMTP_STARTTLS_PORT > 0) {
  const s = net.createServer((socket) => smtp.startPlain(socket, s));
  s.on('error', (err) => {
    console.error(`[smtp] 端口 ${SMTP_STARTTLS_PORT} 监听失败：${err.message}`);
    process.exit(1);
  });
  s.listen(SMTP_STARTTLS_PORT, HOST, () => {
    console.log(`[smtp] listening on ${HOST}:${SMTP_STARTTLS_PORT} (STARTTLS, AUTH → /api/email/send)`);
  });
  smtpServers.push(s);
} else {
  console.log('[smtp] 587 STARTTLS 入口已关闭（SMTP_PORT_STARTTLS=0）');
}

/* ------------------------------------------------------------------ 优雅退出 */

function shutdown(signal) {
  console.log(`[lifecycle] 收到 ${signal}，正在关闭监听…`);
  try { imap.close(); } catch (e) { /* 忽略 */ }
  for (const s of smtpServers) {
    try { s.close(); } catch (e) { /* 忽略 */ }
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
