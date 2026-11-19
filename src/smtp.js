/**
 * [S37] SMTP 发信网关 —— P4 / P5（v0.2.2 三入口 → v0.2.16 收敛为单入口）
 *
 * 入口（由 index.js 按 env 决定是否挂载）：
 *   2465 隐式 TLS ← 当前唯一对外入口（465/587 在国内链路不可用，已关闭）
 *   465  隐式 TLS（已停用，env SMTP_PORT=0 即关）
 *   587  明文 + STARTTLS（已停用，env SMTP_PORT_STARTTLS=0 即关）
 *
 * AUTH PLAIN / LOGIN：复用应用密码（转调 Worker /api/imap/auth 校验，限流同 IMAP）
 * MAIL FROM：必须等于认证邮箱（账号级强隔离，管理员无特权）
 * DATA：mailparser 解析 RFC822 → 转调 Worker /api/email/send（渠道、配额、归属校验全复用）
 * 发送记录由 Worker 落库，已发送文件夹自动同步。
 */
'use strict';

import tls from 'node:tls';
import { simpleParser } from 'mailparser';

const MAX_SIZE = 26_214_400;       // 与 EHLO 宣告的 SIZE 一致（25MB）
const DATA_HARD_LIMIT = 32_000_000; // DATA 收集硬上限，防内存打爆
const MAX_RCPT = 50;
const AUTH_FAIL_DELAY_MS = 800;    // 认证失败延迟，防爆破
const HANDSHAKE_TIMEOUT_MS = 15000; // STARTTLS 握手超时

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function b64decode(s) {
  try {
    return Buffer.from(String(s).trim(), 'base64').toString('utf8');
  } catch (e) {
    return null;
  }
}

// MAIL FROM:<a@b.c> SIZE=123 / RCPT TO:<a@b.c> → { addr, size }
function parsePath(line, verb) {
  const m = line.match(new RegExp(`^${verb}\\s*:\\s*<([^>]*)>(.*)$`, 'i'));
  if (!m) return null;
  const rest = m[2] || '';
  let size = 0;
  const sm = rest.match(/\bSIZE\s*=\s*(\d+)/i);
  if (sm) size = Number(sm[1]);
  return { addr: m[1].trim(), size };
}

// 把 Worker / 前端的错误消息清洗成单行 SMTP 响应文本
function cleanMsg(msg) {
  return String(msg || 'internal error').replace(/[\r\n]+/g, ' ').slice(0, 200);
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 创建 SMTP 会话启动器。
 * @returns {{ startSecure(socket): void, startPlain(socket, server): void }}
 */
export function createSmtpStarter({ tlsOptions, workerClient }) {
  const secureContext = tls.createSecureContext(tlsOptions);

  // STARTTLS：明文 socket 原地升级为 TLS（参考 node 内部与 smtp-server 的做法：
  // 先 pause + 移除旧监听，再包 TLSSocket，'secure' 事件后起新会话）
  function upgradeToTls(socket, tlsServer) {
    socket.setTimeout(0);
    socket.pause();
    socket.removeAllListeners('data');
    socket.removeAllListeners('timeout');
    const onError = () => { try { socket.destroy(); } catch (e) { /* 忽略 */ } };
    socket.on('error', onError);

    let secure;
    try {
      secure = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext,
        server: tlsServer,
      });
    } catch (e) {
      try { socket.destroy(); } catch (e2) { /* 忽略 */ }
      return;
    }

    secure.setTimeout(HANDSHAKE_TIMEOUT_MS, () => secure.destroy(new Error('STARTTLS handshake timeout')));
    secure.once('error', () => { try { secure.destroy(); } catch (e) { /* 忽略 */ } });
    secure.once('secure', () => {
      secure.setTimeout(0);
      startSession(secure, true, tlsServer);
    });
  }

  function startSession(socket, isSecure, tlsServer) {
    socket.setTimeout(120000);
    socket.setNoDelay(true);
    socket.write('220 cmimap ESMTP ready\r\n');

    // 会话状态
    const st = {
      authed: null,     // { email, appPassword, session }（worker 会话缓存对象）
      mailFrom: null,
      rcptTo: [],
      dataMode: false,
      dataBuf: [],
      dataSize: 0,
      authStage: null,  // 'login-user' | 'login-pass' | 'plain'
    };

    let buf = '';

    const send = (s) => { if (!socket.destroyed) socket.write(s); };

    function resetMail() {
      st.mailFrom = null;
      st.rcptTo = [];
    }

    async function handleAuth(argLine) {
      if (st.authed) {
        send('503 5.5.1 Already authenticated\r\n');
        return;
      }
      const parts = argLine.trim().split(/\s+/);
      const mech = (parts[0] || '').toUpperCase();

      if (mech === 'PLAIN') {
        let payload = parts[1];
        if (!payload) {
          st.authStage = 'plain';
          send('334 \r\n');
          return;
        }
        return finishAuthPlain(payload);
      }

      if (mech === 'LOGIN') {
        if (parts[1]) {
          return finishAuthUser(parts[1]);
        }
        st.authStage = 'login-user';
        send('334 VXNlcm5hbWU6\r\n');
        return;
      }

      send('504 5.5.4 Unrecognized authentication type\r\n');
    }

    async function finishAuthPlain(payload) {
      const decoded = b64decode(payload);
      // PLAIN 格式：authzid \0 authcid \0 passwd
      const segs = decoded === null ? [] : decoded.split('\0');
      const email = (segs.length >= 2 ? segs[1] : '').trim();
      const password = segs.length >= 3 ? segs[2] : '';
      await doAuth(email, password);
    }

    async function finishAuthUser(payload) {
      const email = (b64decode(payload) || '').trim();
      st.authStage = 'login-pass';
      st.pendingUser = email;
      send('334 UGFzc3dvcmQ6\r\n');
    }

    async function finishAuthPass(payload) {
      const password = b64decode(payload) || '';
      await doAuth(st.pendingUser || '', password);
      st.pendingUser = '';
    }

    async function doAuth(email, password) {
      if (!EMAIL_RE.test(email) || !password) {
        await delay(AUTH_FAIL_DELAY_MS);
        send('535 5.7.8 Authentication credentials invalid\r\n');
        return;
      }
      try {
        // 复用 worker-client 登录：应用密码错误时这里抛错（Worker 侧自带 IP 限流）
        const session = await workerClient.login(email, password);
        st.authed = { email: email.toLowerCase(), appPassword: password, session };
        st.authStage = null;
        send('235 2.7.0 Authentication successful\r\n');
      } catch (e) {
        st.authStage = null;
        await delay(AUTH_FAIL_DELAY_MS);
        send('535 5.7.8 Authentication credentials invalid\r\n');
      }
    }

    // DATA 结束：组装正文并转调 Worker 发送
    async function finishData() {
      st.dataMode = false;
      const body = Buffer.concat(st.dataBuf);
      st.dataBuf = [];
      st.dataSize = 0;
      const rcpt = st.rcptTo;
      st.rcptTo = [];
      const from = st.mailFrom;
      st.mailFrom = null;
      if (!from || rcpt.length === 0) {
        send('554 5.5.1 No valid transaction\r\n');
        return;
      }
      await handleData(body, rcpt);
    }

    async function handleData(body, rcptTo) {
      const { authed } = st;
      let parsed;
      try {
        parsed = await simpleParser(body);
      } catch (e) {
        send('554 5.6.0 Message parse failed\r\n');
        return;
      }

      const subject = parsed.subject || '';
      const html = typeof parsed.html === 'string' ? parsed.html : '';
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      if (!html && !text) {
        send('554 5.6.0 Empty message body\r\n');
        return;
      }

      let name = '';
      try {
        const f = parsed.from && parsed.from.value && parsed.from.value[0];
        if (f && f.name && f.name !== f.address) name = f.name;
      } catch (e) { /* 忽略 */ }

      const attachments = (parsed.attachments || []).map(a => {
        const item = {
          filename: a.filename || 'untitled',
          content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : '',
          contentType: a.contentType || 'application/octet-stream',
        };
        if (a.cid) item.contentId = String(a.cid).replace(/^<|>$/g, '');
        return item;
      });
      if (attachments.length > 10) {
        send('554 5.5.3 Too many attachments (max 10)\r\n');
        return;
      }

      const payload = {
        accountId: authed.session.accountId,
        name,
        sendType: '',
        receiveEmail: rcptTo,
        text,
        content: html,
        subject,
        attachments,
      };

      try {
        await workerClient.authedRequest(authed.email, authed.appPassword, '/api/email/send', {
          method: 'POST',
          body: payload,
        });
        send('250 2.0.0 OK: message accepted\r\n');
      } catch (e) {
        const s = Number(e.status) || 0;
        // 参数/权限类错误（4xx 语义除外）回 554，其余回 451 允许客户端重试
        if (s >= 500 && s !== 503) {
          send(`554 5.0.0 ${cleanMsg(e.message)}\r\n`);
        } else if (s >= 400) {
          send(`451 4.7.1 ${cleanMsg(e.message)}\r\n`);
        } else {
          send(`451 4.3.0 Send failed: ${cleanMsg(e.message)}\r\n`);
        }
      }
    }

    async function handleLine(line) {
      // 仅处理命令行；DATA 正文在 onData 里收集，此函数只接结束符 "."
      if (st.dataMode) {
        if (line === '.') await finishData();
        return;
      }

      // [S37/v0.2.12] AUTH 的凭据续行是 base64，不是 SMTP 命令，必须在按 verb 分派之前截走。
      // 少了这段会导致：EHLO 宣告了 LOGIN 机制 → 客户端发 AUTH LOGIN → 收到 334 →
      // 接着发的用户名/密码行被当成未知命令回 500，LOGIN 认证实际完全不可用
      // （Outlook / 部分 Foxmail / 密码含特殊字符的客户端会走 LOGIN 而不是 PLAIN）。
      if (st.authStage) {
        if (line.trim() === '*') {
          // RFC 4954：客户端可用 "*" 取消认证
          st.authStage = null;
          st.pendingUser = '';
          send('501 5.7.0 Authentication cancelled\r\n');
          return;
        }
        if (st.authStage === 'login-user') return finishAuthUser(line);
        if (st.authStage === 'login-pass') return finishAuthPass(line);
        if (st.authStage === 'plain') return finishAuthPlain(line);
      }

      const verb = line.slice(0, 4).toUpperCase();

      switch (true) {
        case verb === 'QUIT':
          send('221 2.0.0 Bye\r\n');
          socket.end();
          return;
        case verb === 'EHLO' || verb === 'HELO':
          if (verb === 'EHLO') {
            const lines = ['250-cmimap', '250-SIZE 26214400', '250-AUTH PLAIN LOGIN', '250-8BITMIME'];
            if (!isSecure) lines.push('250-STARTTLS');
            lines.push('250 PIPELINING');
            send(lines.join('\r\n') + '\r\n');
          } else {
            send('250 cmimap\r\n');
          }
          return;
        case verb === 'AUTH':
          await handleAuth(line.slice(4));
          return;
        case verb === 'MAIL': {
          if (!st.authed) {
            send('530 5.7.0 Authentication required\r\n');
            return;
          }
          if (st.mailFrom) {
            send('503 5.5.1 Sender already specified\r\n');
            return;
          }
          const p = parsePath(line, 'MAIL FROM');
          if (!p || !EMAIL_RE.test(p.addr)) {
            send('501 5.1.7 Bad sender address syntax\r\n');
            return;
          }
          if (p.addr.toLowerCase() !== st.authed.email) {
            // 账号级强隔离：只能以认证邮箱本人身份发信
            send('553 5.7.1 Sender address not allowed for this account\r\n');
            return;
          }
          if (p.size > MAX_SIZE) {
            send('552 5.3.4 Message size exceeds limit\r\n');
            return;
          }
          st.mailFrom = p.addr.toLowerCase();
          send('250 2.1.0 OK\r\n');
          return;
        }
        case verb === 'RCPT': {
          if (!st.authed) {
            send('530 5.7.0 Authentication required\r\n');
            return;
          }
          if (!st.mailFrom) {
            send('503 5.5.1 Need MAIL command first\r\n');
            return;
          }
          const p = parsePath(line, 'RCPT TO');
          if (!p || !EMAIL_RE.test(p.addr)) {
            send('501 5.1.3 Bad recipient address syntax\r\n');
            return;
          }
          if (st.rcptTo.length >= MAX_RCPT) {
            send('452 4.5.3 Too many recipients\r\n');
            return;
          }
          st.rcptTo.push(p.addr.toLowerCase());
          send('250 2.1.5 OK\r\n');
          return;
        }
        case verb === 'DATA': {
          if (!st.authed) {
            send('530 5.7.0 Authentication required\r\n');
            return;
          }
          if (!st.mailFrom) {
            send('503 5.5.1 Need MAIL command first\r\n');
            return;
          }
          if (st.rcptTo.length === 0) {
            send('503 5.5.1 Need RCPT command first\r\n');
            return;
          }
          st.dataMode = true;
          st.dataBuf = [];
          st.dataSize = 0;
          send('354 End data with <CR><LF>.<CR><LF>\r\n');
          return;
        }
        case verb === 'RSET':
          resetMail();
          send('250 2.0.0 OK\r\n');
          return;
        case verb === 'NOOP':
          send('250 2.0.0 OK\r\n');
          return;
        case verb === 'VRFY':
          send('252 2.5.2 Cannot VRFY user\r\n');
          return;
        case line.slice(0, 8).toUpperCase() === 'STARTTLS':
          if (isSecure) {
            send('454 4.7.0 TLS already active\r\n');
            return;
          }
          send('220 2.0.0 Ready to start TLS\r\n');
          upgradeToTls(socket, tlsServer);
          return;
        case line === '':
          send('500 5.5.2 Empty command\r\n');
          return;
        default:
          send('500 5.5.2 Command not recognized\r\n');
      }
    }

    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (st.dataMode) {
          // DATA 正文按行收集，处理是异步的但行间无依赖，直接同步入栈
          if (line === '.') {
            handleLine(line).catch(() => {});
          } else {
            const unstuffed = line.startsWith('..') ? line.slice(1) : line;
            const c = Buffer.from(unstuffed + '\r\n', 'utf8');
            st.dataSize += c.length;
            if (st.dataSize > DATA_HARD_LIMIT) {
              st.dataMode = false;
              st.dataBuf = [];
              st.dataSize = 0;
              resetMail();
              send('552 5.3.4 Message too large\r\n');
              return;
            }
            st.dataBuf.push(c);
          }
        } else {
          handleLine(line).catch((e) => {
            try { send('421 4.3.0 Internal error\r\n'); socket.end(); } catch (e2) { /* 忽略 */ }
          });
        }
      }
    };

    const onError = () => {};
    const onTimeout = () => socket.destroy();

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('timeout', onTimeout);
  }

  return {
    // TLS 服务器（465 / 2465）直接用
    startSecure(socket) {
      startSession(socket, true);
    },
    // 明文服务器（587）用：保留 server 引用供 STARTTLS 升级
    startPlain(socket, tlsServer) {
      startSession(socket, false, tlsServer || null);
    },
  };
}

// 兼容导出：465 隐式 TLS 服务器（index.js 仍可单独建）
export function createSmtpServer({ tlsOptions, workerClient }) {
  const { startSecure } = createSmtpStarter({ tlsOptions, workerClient });
  return tls.createServer(tlsOptions, startSecure);
}
