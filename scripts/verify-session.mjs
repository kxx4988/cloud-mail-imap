/**
 * [S37] 会话层集成自检：起一个真实 IMAP server（明文、内存适配器），用真实 socket 打协议。
 *
 * 覆盖 v0.2.15 的三处修复：
 *   · literal：同步 {n} 必须回 "+"，非同步 {n+} 不许回 "+"，内容要真的进命令（中文/ASCII）
 *   · NOOP  : 邮箱新增邮件后必须推 `* n EXISTS`（否则客户端轮询永远看不到新邮件）
 *   · SEARCH: 结果必须是升序（RFC 3501 §6.4.4）
 *
 * 用法：node scripts/verify-session.mjs
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

/* ---------------------------------------------------- 内存适配器（模拟站内邮箱） */

const MAILBOX = 't@example.com';
const FOLDER_ID = `inbox:${MAILBOX}`;
// 故意按「最新在前」存放：真实环境 listEmails 就是这个顺序，
// SEARCH 必须自己纠正成升序。
let messages = [
  { uid: 5, subject: 'hello world', body: 'plain' },
  { uid: 3, subject: '测试邮件', body: '正文' },
];

const mailboxAdapter = {
  async listFolders() {
    return [{ id: FOLDER_ID, name: 'INBOX', slug: 'inbox' }];
  },
  async getFolderByName(_mb, name) {
    if (String(name).toUpperCase() !== 'INBOX') return undefined;
    return { id: FOLDER_ID, name: 'INBOX', slug: 'inbox' };
  },
  async getFolderStats() {
    return {
      messages: messages.length,
      recent: 0,
      unseen: 0,
      uidValidity: 1,
      uidNext: Math.max(0, ...messages.map(m => m.uid)) + 1,
      flags: ['\\Seen'],
      permanentFlags: ['\\Seen'],
    };
  },
  async getMessageUids() {
    return messages
      .map(m => ({ uid: m.uid, messageId: `${m.uid}:${MAILBOX}` }))
      .sort((a, b) => a.uid - b.uid);
  },
};

const messageAdapter = {
  async searchMessages(_folderId, criteria) {
    const crits = (criteria || []).filter(c => c && c.type);
    const hit = crits.length
      ? messages.filter(m => crits.every((c) => {
        // SUBJECT 在库解析出来是 { type: 'header', field: 'subject', value }，
        // 与真实 adapters.matchCriterion 的口径一致
        if (c.type === 'header') {
          if (String(c.field).toLowerCase() !== 'subject') return false;
          return String(m.subject).toLowerCase().includes(String(c.value).toLowerCase());
        }
        if (c.type === 'text' || c.type === 'body') return String(m.body).includes(String(c.value));
        return true;
      }))
      : messages;
    // 真实适配器按 listEmails 顺序返回（最新在前）→ 这里保持降序
    return hit.map(m => `${m.uid}:${MAILBOX}`).sort((a, b) => Number(b.split(':')[0]) - Number(a.split(':')[0]));
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
};

const authAdapter = {
  async verifyAppPassword(email, pwd) {
    return email.toLowerCase() === MAILBOX && pwd === 'pwd';
  },
};

/* -------------------------------------------------------------- 简易 IMAP 客户端 */

function makeClient(port) {
  const sock = net.connect(port, '127.0.0.1');
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => { buf += d; });
  return {
    sock,
    get buffer() { return buf; },
    reset() { buf = ''; },
    async waitFor(pred, ms = 4000) {
      const t0 = Date.now();
      for (;;) {
        if (pred(buf)) return buf;
        if (Date.now() - t0 > ms) return null;
        await new Promise(r => setTimeout(r, 10));
      }
    },
    send(s) { sock.write(s); },
  };
}

/* ---------------------------------------------------------------------- 主流程 */

const server = createImapServer({
  adapters: { authAdapter, mailboxAdapter, messageAdapter },
  host: '127.0.0.1',
  port: 0,
  maxConnections: 5,
  sessionTimeoutMs: 60_000,
  // 与 src/index.js 一致：mailboxId 就是邮箱地址本身，缺了它 SELECT 会回
  // "No mailbox resolved for this session"，整条会话链路都起不来
  async resolveMailboxId(email) {
    return String(email).toLowerCase();
  },
});

await server.listen();
const port = server.port;
console.log(`[verify-session] 服务已起在 127.0.0.1:${port}\n`);

const cli = makeClient(port);

// 1) 问候 + 登录
ok('问候带 CAPABILITY', !!(await cli.waitFor(b => b.includes('* OK'))));
cli.send(`a1 LOGIN "${MAILBOX}" "pwd"\r\n`);
ok('LOGIN 成功', !!(await cli.waitFor(b => b.includes('a1 OK'))));

// 2) SELECT
cli.reset();
cli.send('a2 SELECT INBOX\r\n');
ok('SELECT 返回 2 EXISTS', !!(await cli.waitFor(b => b.includes('a2 ') && b.includes('* 2 EXISTS'))));

// 3) 同步 literal {n}：必须回 "+"，内容进命令
cli.reset();
cli.send('a3 UID SEARCH SUBJECT {5}\r\n');
ok('同步 literal 回 "+ Ready"', !!(await cli.waitFor(b => b.includes('+ Ready for literal data'))));
cli.send('hello\r\n');
const r3 = await cli.waitFor(b => b.includes('a3 '));
ok('同步 literal 后命令正常完成', !!r3 && r3.includes('a3 OK'), r3 || 'timeout');
ok('同步 literal 内容真的参与了搜索', !!r3 && r3.includes('* SEARCH 5'), r3 ? JSON.stringify(r3) : '');
ok('同步 literal 不产生 BAD 污染', !!r3 && !r3.includes('* BAD'), r3 ? JSON.stringify(r3) : '');

// 4) 非同步 literal {n+}：不许回 "+"
cli.reset();
cli.send('a4 UID SEARCH SUBJECT {5+}\r\nhello\r\n');
const r4 = await cli.waitFor(b => b.includes('a4 '));
ok('非同步 literal 不回 "+"', !!r4 && !r4.includes('+ Ready'), r4 ? JSON.stringify(r4) : 'timeout');
ok('非同步 literal 命令正常完成', !!r4 && r4.includes('a4 OK'), r4 || 'timeout');
ok('非同步 literal 命中正确', !!r4 && r4.includes('* SEARCH 5'), r4 ? JSON.stringify(r4) : '');

// 5) 中文 literal（UTF-8 多字节，长度必须按字节算）
cli.reset();
const zh = Buffer.from('测试', 'utf8'); // 6 字节
cli.send(`a5 UID SEARCH SUBJECT {${zh.length}}\r\n`);
await cli.waitFor(b => b.includes('+ Ready'));
cli.send(Buffer.concat([zh, Buffer.from('\r\n')]));
const r5 = await cli.waitFor(b => b.includes('a5 '));
ok('中文 literal 长度按字节计算', !!r5 && r5.includes('a5 OK'), r5 || 'timeout');
ok('中文 literal 命中中文主题', !!r5 && r5.includes('* SEARCH 3'), r5 ? JSON.stringify(r5) : '');

// 6) SEARCH 结果升序
cli.reset();
cli.send('a6 UID SEARCH ALL\r\n');
const r6 = await cli.waitFor(b => b.includes('a6 '));
const seqLine = r6 ? (r6.split('\r\n').find(l => l.startsWith('* SEARCH')) || '') : '';
ok('SEARCH 结果为升序', seqLine.trim() === '* SEARCH 3 5', JSON.stringify(seqLine));

// 7) NOOP 刷新：新增一封后应推 EXISTS
messages = [...messages, { uid: 7, subject: '新邮件 arrived', body: 'z' }];
cli.reset();
cli.send('a7 NOOP\r\n');
const r7 = await cli.waitFor(b => b.includes('a7 '));
ok('NOOP 推送新的 EXISTS', !!r7 && r7.includes('* 3 EXISTS'), r7 ? JSON.stringify(r7) : 'timeout');
ok('NOOP 本身仍回 OK', !!r7 && r7.includes('a7 OK'), r7 ? JSON.stringify(r7) : '');

// 8) NOOP 无变化时不重复推
cli.reset();
cli.send('a8 NOOP\r\n');
const r8 = await cli.waitFor(b => b.includes('a8 '));
ok('无变化时不重复推 EXISTS', !!r8 && !r8.includes('EXISTS'), r8 ? JSON.stringify(r8) : 'timeout');

// 9) IDLE 进出正常
cli.reset();
cli.send('a9 IDLE\r\n');
ok('IDLE 回 "+ idling"', !!(await cli.waitFor(b => b.includes('+ idling'))));
cli.send('DONE\r\n');
ok('IDLE DONE 正常收尾', !!(await cli.waitFor(b => b.includes('a9 OK'))));

// 10) 新 UID 已进入映射（EXISTS 推送后客户端要能按 UID 检索到新邮件）
cli.reset();
cli.send('a10 UID SEARCH ALL\r\n');
const r10 = await cli.waitFor(b => b.includes('a10 '));
const seq10 = r10 ? (r10.split('\r\n').find(l => l.startsWith('* SEARCH')) || '') : '';
ok('推送 EXISTS 后 uidMap 已重建（新 UID 可检索）', seq10.trim() === '* SEARCH 3 5 7', JSON.stringify(seq10));

cli.send('a11 LOGOUT\r\n');
await cli.waitFor(b => b.includes('a11 OK'));
cli.sock.end();

await server.close();
console.log(`\n${fails.length ? '❌' : '✅'} 会话层自检：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.log('   - ' + f);
  process.exit(1);
}
