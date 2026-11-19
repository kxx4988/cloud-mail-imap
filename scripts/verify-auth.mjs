/**
 * [v0.2.18] 第三方客户端兼容性自检：AUTHENTICATE PLAIN + SEARCH CHARSET
 *
 * 背景：CAPABILITY 原来不含任何 AUTH= 机制，且 `AUTHENTICATE` 回 BAD Unknown command；
 *       `SEARCH CHARSET UTF-8`（Thunderbird / Outlook 搜中文必带）也直接 BAD。
 * 这里用真实 socket 打本地明文 server，覆盖：
 *   · CAPABILITY / greeting 声明 AUTH=PLAIN
 *   · AUTHENTICATE 带初始响应、两步握手、错误密码、未知机制、客户端取消
 *   · SEARCH CHARSET UTF-8（含中文 literal）/ US-ASCII / 不支持的字符集回 BADCHARSET
 *
 * 用法：node scripts/verify-auth.mjs
 */
import net from 'node:net';
import { createImapServer } from '@rafters/mail-imap-server';

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name + (extra ? `（${extra}）` : ''));
    console.log(`  ✗ ${name}${extra ? `  ← ${extra}` : ''}`);
  }
}

const MAILBOX = 't@example.com';
const PASSWORD = 'pwd';
const FOLDER_ID = `inbox:${MAILBOX}`;
const messages = [
  { uid: 5, subject: 'hello world', body: 'plain' },
  { uid: 3, subject: '测试邮件', body: '正文' },
];

const server = createImapServer({
  adapters: {
    authAdapter: {
      async verifyAppPassword(email, pwd) {
        return String(email).toLowerCase() === MAILBOX && pwd === PASSWORD;
      },
    },
    mailboxAdapter: {
      async listFolders() { return [{ id: FOLDER_ID, name: 'INBOX', slug: 'inbox' }]; },
      async getFolderByName(_mb, name) {
        if (String(name).toUpperCase() !== 'INBOX') return undefined;
        return { id: FOLDER_ID, name: 'INBOX', slug: 'inbox' };
      },
      async getFolderStats() {
        return { messages: messages.length, recent: 0, unseen: 0, uidValidity: 1, uidNext: 6, flags: ['\\Seen'], permanentFlags: ['\\Seen'] };
      },
      async getMessageUids() {
        return messages.map(m => ({ uid: m.uid, messageId: `${m.uid}:${MAILBOX}` })).sort((a, b) => a.uid - b.uid);
      },
    },
    messageAdapter: {
      async searchMessages(_folderId, criteria) {
        const crits = (criteria || []).filter(c => c && c.type);
        const hit = crits.length
          ? messages.filter(m => crits.every((c) => {
            if (c.type === 'header') {
              if (String(c.field).toLowerCase() !== 'subject') return false;
              return String(m.subject).toLowerCase().includes(String(c.value).toLowerCase());
            }
            if (c.type === 'text' || c.type === 'body') return String(m.body).includes(String(c.value));
            return true;
          }))
          : messages;
        return hit.map(m => `${m.uid}:${MAILBOX}`);
      },
      async getMessage(id) {
        const uid = Number(String(id).split(':')[0]);
        const m = messages.find(x => x.uid === uid);
        if (!m) return undefined;
        return { uid, flags: [], internalDate: new Date(), size: 10, body: m.body, headers: `Subject: ${m.subject}\r\n` };
      },
      async getMessagesByIds(ids) {
        const out = [];
        for (const id of ids || []) {
          const m = await this.getMessage(id);
          if (m) out.push(m);
        }
        return out;
      },
      async updateMessageFlags() {},
      async deleteMessage() {},
      async getBlob() { return ''; },
      async getSection() { return undefined; },
    },
  },
  host: '127.0.0.1',
  port: 0,
  maxConnections: 5,
  sessionTimeoutMs: 30_000,
  async resolveMailboxId(email) { return String(email).toLowerCase(); },
});
await server.listen();

/* -------------------------------------------------------------- 客户端 */

function conn() {
  const sock = net.connect(server.port, '127.0.0.1');
  const c = { sock, buf: '' };
  sock.setEncoding('utf8');
  sock.on('data', (d) => { c.buf += d; });
  c.wait = async (pred, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      if (pred(c.buf)) return c.buf;
      if (Date.now() - t0 > ms) return null;
      await new Promise(r => setTimeout(r, 10));
    }
  };
  c.reset = () => { c.buf = ''; };
  c.send = (s) => { sock.write(s); };
  c.sendBuf = (b) => { sock.write(b); };
  c.close = () => { try { sock.end(); } catch { /* noop */ } };
  return c;
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const plainCred = (user, pwd) => b64(`\u0000${user}\u0000${pwd}`);

/* ------------------------------------------------ 1. 能力声明 */

console.log('[1] 能力声明');
const c1 = conn();
const greet = await c1.wait(b => b.includes('* OK'));
ok('greeting 声明 AUTH=PLAIN', !!greet && greet.includes('AUTH=PLAIN'), greet ? greet.trim() : 'timeout');
c1.reset();
c1.send('a1 CAPABILITY\r\n');
const cap = await c1.wait(b => b.includes('a1 OK'));
ok('CAPABILITY 含 AUTH=PLAIN', !!cap && cap.includes('AUTH=PLAIN'));
ok('CAPABILITY 仍含 IMAP4rev1 / IDLE / LITERAL+',
  !!cap && cap.includes('IMAP4rev1') && cap.includes('IDLE') && cap.includes('LITERAL+'));
c1.close();

/* ------------------------------------ 2. AUTHENTICATE PLAIN 带初始响应 */

console.log('[2] AUTHENTICATE PLAIN（带初始响应）');
const c2 = conn();
await c2.wait(b => b.includes('* OK'));
c2.reset();
c2.send(`a2 AUTHENTICATE PLAIN ${plainCred(MAILBOX, PASSWORD)}\r\n`);
const r2 = await c2.wait(b => b.includes('a2 '));
ok('认证成功回 OK', !!r2 && r2.includes('a2 OK'), r2 ? r2.trim() : 'timeout');
c2.reset();
c2.send('a3 SELECT INBOX\r\n');
const sel2 = await c2.wait(b => b.includes('a3 '));
ok('认证后可直接 SELECT', !!sel2 && sel2.includes('a3 OK'), sel2 ? sel2.trim().slice(0, 80) : 'timeout');
c2.close();

/* ------------------------------------------ 3. AUTHENTICATE PLAIN 两步握手 */

console.log('[3] AUTHENTICATE PLAIN（两步握手）');
const c3 = conn();
await c3.wait(b => b.includes('* OK'));
c3.reset();
c3.send('a4 AUTHENTICATE PLAIN\r\n');
const cont = await c3.wait(b => b.trim().length > 0);
ok('服务器回 "+" 继续提示', !!cont && /^\+/m.test(cont), cont ? JSON.stringify(cont) : 'timeout');
c3.reset();
c3.send(`${plainCred(MAILBOX, PASSWORD)}\r\n`);
const r4 = await c3.wait(b => b.includes('a4 '));
ok('两步握手认证成功', !!r4 && r4.includes('a4 OK'), r4 ? r4.trim() : 'timeout');
c3.close();

/* ------------------------------------------------- 4. 失败与异常路径 */

console.log('[4] 失败与异常路径');
const c4 = conn();
await c4.wait(b => b.includes('* OK'));
c4.reset();
c4.send(`a5 AUTHENTICATE PLAIN ${plainCred(MAILBOX, 'wrong')}\r\n`);
const r5 = await c4.wait(b => b.includes('a5 '));
ok('错误密码回 NO', !!r5 && r5.includes('a5 NO'), r5 ? r5.trim() : 'timeout');
c4.reset();
c4.send(`a6 AUTHENTICATE LOGIN ${b64('x')}\r\n`);
const r6 = await c4.wait(b => b.includes('a6 '));
ok('未知机制回 NO 而不是 BAD', !!r6 && r6.includes('a6 NO'), r6 ? r6.trim() : 'timeout');
c4.close();

const c5 = conn();
await c5.wait(b => b.includes('* OK'));
c5.reset();
c5.send('a7 AUTHENTICATE PLAIN\r\n');
await c5.wait(b => /^\+/m.test(b));
c5.reset();
c5.send('*\r\n');
const r7 = await c5.wait(b => b.includes('a7 '));
ok('客户端取消（*）回 BAD cancelled', !!r7 && r7.includes('a7 BAD') && /cancelled/i.test(r7), r7 ? r7.trim() : 'timeout');
c5.close();

/* ------------------------------------------------------ 5. SEARCH CHARSET */

console.log('[5] SEARCH CHARSET');
const c6 = conn();
await c6.wait(b => b.includes('* OK'));
c6.reset();
c6.send(`a8 LOGIN "${MAILBOX}" "${PASSWORD}"\r\n`);
await c6.wait(b => b.includes('a8 '));
c6.reset();
c6.send('a9 SELECT INBOX\r\n');
await c6.wait(b => b.includes('a9 '));

// UTF-8 + quoted string
c6.reset();
c6.send('a10 SEARCH CHARSET UTF-8 SUBJECT "hello"\r\n');
const r10 = await c6.wait(b => b.includes('a10 '));
ok('CHARSET UTF-8 + quoted 命中', !!r10 && r10.includes('a10 OK') && r10.includes('* SEARCH'), r10 ? r10.trim() : 'timeout');

// UTF-8 + 中文 literal（RFC 3501 同步 literal）
c6.reset();
const zh = Buffer.from('测试', 'utf8');
c6.send(`a11 SEARCH CHARSET UTF-8 SUBJECT {${zh.length}}\r\n`);
const litPlus = await c6.wait(b => b.includes('+ '));
ok('CHARSET UTF-8 后仍能收 literal', !!litPlus && litPlus.includes('+ '), litPlus ? JSON.stringify(litPlus) : 'timeout');
c6.reset();
c6.sendBuf(Buffer.concat([zh, Buffer.from('\r\n')]));
const r11 = await c6.wait(b => b.includes('a11 '));
ok('CHARSET UTF-8 + 中文 literal 命中', !!r11 && r11.includes('a11 OK') && /\* SEARCH \d+/.test(r11), r11 ? r11.trim() : 'timeout');

// US-ASCII
c6.reset();
c6.send('a12 SEARCH CHARSET US-ASCII SUBJECT "hello"\r\n');
const r12 = await c6.wait(b => b.includes('a12 '));
ok('CHARSET US-ASCII 正常', !!r12 && r12.includes('a12 OK'), r12 ? r12.trim() : 'timeout');

// 不支持的字符集
c6.reset();
c6.send('a13 SEARCH CHARSET GB2312 SUBJECT "hello"\r\n');
const r13 = await c6.wait(b => b.includes('a13 '));
ok('不支持的字符集回 NO [BADCHARSET]',
  !!r13 && r13.includes('a13 NO') && r13.includes('BADCHARSET'),
  r13 ? r13.trim() : 'timeout');
ok('BADCHARSET 列出可用字符集', !!r13 && /BADCHARSET \(UTF-8 US-ASCII\)/.test(r13), r13 ? r13.trim() : '');

// 无 CHARSET 的老写法不受影响
c6.reset();
c6.send('a14 SEARCH SUBJECT "hello"\r\n');
const r14 = await c6.wait(b => b.includes('a14 '));
ok('不带 CHARSET 的老写法仍正常', !!r14 && r14.includes('a14 OK'), r14 ? r14.trim() : 'timeout');

c6.send('a15 LOGOUT\r\n');
await c6.wait(b => b.includes('a15 '));
c6.close();

await server.close();
console.log(`\n${fails.length ? '❌' : '✅'} 兼容性自检：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.log('   - ' + f);
  process.exit(1);
}
