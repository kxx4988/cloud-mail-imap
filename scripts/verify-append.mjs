/**
 * [S37] APPEND 集成自检（v0.2.20）：
 * Apple Mail 等客户端发信后会把副本 APPEND 到「已发送」，此前网关回
 * "NO APPEND not supported" 导致每次发信弹窗。
 *
 * 覆盖：
 *   · 单元：findSentDuplicate 去重判据（To 交集 / ±30 分钟窗 / subject 相等 /
 *     encoded-word 解码 / recipient JSON 多地址）
 *   · 协议：APPEND Sent 同步 literal → "+ Ready" → "OK [APPENDUID …]"；其他文件夹静默 OK；
 *     未知文件夹 NO Mailbox not found
 *   · [v0.2.22] COPY/MOVE Trash → OK + 软删除（Apple Mail 删除流程第一步）；
 *     COPY 到非回收站仍 NO（移动不做）；UID MOVE 带 EXPUNGE 响应
 *   · [v0.2.23] COPY/MOVE Junk → OK + 站内标垃圾；执行期失败回 tagged NO（补丁 26）
 *
 * 用法：node scripts/verify-append.mjs
 */
import net from 'node:net';
import { createImapServer } from '@rafters/mail-imap-server';
import { findSentDuplicate } from '../src/adapters.js';

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

/* ---------------------------------------------------- 单元：findSentDuplicate */

const REF = new Date('2026-11-13T05:57:43Z');
const list = [
  { emailId: 430, subject: '发送测试', createTime: '2026-11-13 05:57:43', recipient: '[{"address":"user@gmail.com","name":""}]' },
  { emailId: 428, subject: '旧邮件', createTime: '2026-11-12 10:18:47', recipient: '[{"address":"other@x.com","name":""}]' },
];

// Apple Mail 压平后的典型形态（literal 被引号包裹、换行变空格、Subject 是 encoded-word）
function flatMail(to, subjectRaw) {
  return `"Message-ID: <t@test> Date: Thu, 13 Nov 2026 05:57:43 +0000 From: a@b.c To: ${to} `
    + `Subject: ${subjectRaw} Content-Type: text/plain; charset=utf-8 正文压平"`;
}

// encoded-word 由 Buffer 生成，真正的断言见下面各用例
{
  const subj = Buffer.from('发送测试').toString('base64');
  const mail = flatMail('user@gmail.com', `=?UTF-8?B?${subj}?=`);
  ok('去重命中（To 大小写无关 + encoded-word 主题解码后相等）',
    findSentDuplicate(list, mail, REF) === 430, String(findSentDuplicate(list, mail, REF)));
}
ok('未命中：收件人不同',
  findSentDuplicate(list, flatMail('someone@else.com', '=?UTF-8?B?5Yig6Zmk5rWL6K+V?='), REF) === 0, '');
ok('未命中：超出 ±30 分钟窗（同 To 同主题）', (() => {
  const subj = Buffer.from('发送测试').toString('base64');
  const late = new Date(REF.getTime() + 45 * 60 * 1000);
  return findSentDuplicate(list, flatMail('user@gmail.com', `=?UTF-8?B?${subj}?=`), late) === 0;
})(), '');
ok('未命中：窗内同 To 但主题不同', (() => {
  const subj = Buffer.from('不一样的主题').toString('base64');
  return findSentDuplicate(list, flatMail('user@gmail.com', `=?UTF-8?B?${subj}?=`), REF) === 0;
})(), '');
ok('命中：无 To 头不误伤（回 0）',
  findSentDuplicate(list, '"Subject: x"', REF) === 0, '');
ok('命中：Q 编码主题也能解码', (() => {
  // 发送测试 的 Q 编码
  const q = Buffer.from('发送测试', 'utf8').toString('binary')
    .split('').map(c => /[\x20-\x7e]/.test(c) && c !== '=' && c !== '?' ? c : '=' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');
  const mail = flatMail('user@gmail.com', `=?UTF-8?Q?${q}?=`);
  return findSentDuplicate(list, mail, REF) === 430;
})(), '');

/* ---------------------------------------------------- 集成：内存 server 协议测试 */

const MAILBOX = 't@example.com';
const FOLDER_ID = `inbox:${MAILBOX}`;

const mailboxAdapter = {
  async listFolders() {
    return [{ id: FOLDER_ID, name: 'INBOX', slug: 'inbox' }];
  },
  async getFolderByName(_mb, name) {
    if (String(name).toUpperCase() !== 'INBOX') return undefined;
    return { id: FOLDER_ID, name: 'INBOX', slug: 'inbox' };
  },
  async getFolderStats() {
    return { messages: 1, recent: 0, unseen: 0, uidValidity: 1, uidNext: 2, flags: ['\\Seen'], permanentFlags: ['\\Seen'] };
  },
  // [v0.2.27] hidden 用于模拟「这封信已从本文件夹消失」（跨会话 EXPUNGE 判定）
  hidden: new Set(),
  async getMessageUids() {
    return [{ uid: 1, messageId: `1:${MAILBOX}` }, { uid: 2, messageId: `2:${MAILBOX}` }]
      .filter(r => !this.hidden.has(r.uid));
  },
};
const messageAdapter = {
  async searchMessages() { return [`1:${MAILBOX}`, `2:${MAILBOX}`]; },
  async getMessage(messageId) {
    const uid = Number(String(messageId).split(':')[0]) || 1;
    return { uid, flags: [], internalDate: new Date(), size: 10, body: 'b', headers: 'Subject: x\r\n', deletedAt: null };
  },
  async getMessagesByIds(ids) { return ids.map(() => this.getMessage()); },
  // [v0.2.21] 记录 STORE 回写的字段，验证补丁 24（\Deleted → deletedAt）
  flagCalls: [],
  async updateMessageFlags(id, fields) { this.flagCalls.push(fields); },
  async deleteMessage() {},
  async getBlob() { return 'raw'; },
  async getSection() { return undefined; },
};
const authAdapter = {
  async verifyAppPassword(email, pwd) { return email.toLowerCase() === MAILBOX && pwd === 'pwd'; },
};
// 与 src/adapters.js 同构的 extensionAdapter（appendMessage 换成假去重，协议行为一致）
const extensionAdapter = {
  _copyMove: true,
  deleteCalls: [],
  spamCalls: [],
  failSpam: false,
  async getFolderIdByName(mailboxId, name) {
    const map = { INBOX: 'inbox', SENT: 'sent', TRASH: 'trash', JUNK: 'spam' };
    const slug = map[String(name || '').toUpperCase()];
    return slug ? `${slug}:${mailboxId}` : undefined;
  },
  async appendMessage(folderId) {
    return { uidValidity: 1, uid: folderId.startsWith('sent:') ? 430 : 0 };
  },
  // [v0.2.22] 与真实实现同构：Trash = 软删除、Junk = 标垃圾，其他文件夹由 assertCopyTarget 拦成 tagged NO
  assertCopyTarget(targetFolderId) {
    const s = String(targetFolderId);
    if (s.startsWith('trash:') || s.startsWith('spam:')) return null;
    return 'COPY/MOVE not supported (only Trash / Junk)';
  },
  async copyMessage(messageId, targetFolderId) {
    const s = String(targetFolderId);
    if (s.startsWith('spam:')) {
      // [v0.2.23] 模拟「已发送不能标垃圾」之类的执行期失败 → 补丁 26 应回 tagged NO
      if (this.failSpam) {
        const e = new Error('移动失败：只有收件箱邮件可以标记为垃圾邮件');
        e.imapNo = e.message;
        throw e;
      }
      this.spamCalls.push(messageId);
      return { uidValidity: 1, newUid: Number(String(messageId).split(':')[0]) };
    }
    if (!s.startsWith('trash:')) throw new Error('COPY not supported');
    this.deleteCalls.push(messageId);
    return { uidValidity: 1, newUid: Number(String(messageId).split(':')[0]) };
  },
  async moveMessage(messageId, targetFolderId) {
    return this.copyMessage(messageId, targetFolderId);
  },
};

function makeClient(port) {
  const sock = net.connect(port, '127.0.0.1');
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => { buf += d; });
  return {
    sock,
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

const server = createImapServer({
  adapters: { authAdapter, mailboxAdapter, messageAdapter, extensionAdapter },
  host: '127.0.0.1',
  port: 0,
  maxConnections: 5,
  sessionTimeoutMs: 60_000,
  async resolveMailboxId(email) { return String(email).toLowerCase(); },
});
await server.listen();
console.log(`[verify-append] 服务已起在 127.0.0.1:${server.port}\n`);

const cli = makeClient(server.port);
ok('问候', !!(await cli.waitFor(b => b.includes('* OK'))));
cli.send(`a1 LOGIN "${MAILBOX}" "pwd"\r\n`);
ok('LOGIN', !!(await cli.waitFor(b => b.includes('a1 OK'))));

// APPEND Sent：同步 literal → "+" → literal → OK [APPENDUID]
const body = 'Message-ID: <t@test>\r\nDate: Thu, 13 Nov 2026 05:57:43 +0000\r\nFrom: a@b.c\r\nTo: user@gmail.com\r\nSubject: hi\r\n\r\nhello';
cli.reset();
cli.send(`a2 APPEND Sent (\\Seen) {${Buffer.byteLength(body)}}\r\n`);
ok('APPEND Sent 回 "+ Ready"', !!(await cli.waitFor(b => b.includes('+ Ready for literal data'))));
cli.send(body + '\r\n');
const r2 = await cli.waitFor(b => b.includes('a2 '));
ok('APPEND Sent 回 OK', !!r2 && /a2 OK/.test(r2), r2 || 'timeout');
ok('APPENDUID 带 uid（去重命中 430）', !!r2 && r2.includes('[APPENDUID 1 430]'), r2 ? r2.trim() : '');

// APPEND INBOX：静默 OK（uid 0）
cli.reset();
cli.send(`a3 APPEND INBOX (\\Seen) {${Buffer.byteLength(body)}}\r\n`);
await cli.waitFor(b => b.includes('+ Ready'));
cli.send(body + '\r\n');
const r3 = await cli.waitFor(b => b.includes('a3 '));
ok('APPEND INBOX 静默 OK（uid 0）', !!r3 && r3.includes('[APPENDUID 1 0]'), r3 ? r3.trim() : '');

// APPEND 未知文件夹：NO Mailbox not found
cli.reset();
cli.send(`a4 APPEND NonExist (\\Seen) {${Buffer.byteLength(body)}}\r\n`);
await cli.waitFor(b => b.includes('+ Ready'));
cli.send(body + '\r\n');
const r4 = await cli.waitFor(b => b.includes('a4 '));
ok('APPEND 未知文件夹回 NO', !!r4 && /a4 NO/.test(r4) && r4.includes('Mailbox not found'), r4 ? r4.trim() : '');

// [v0.2.22] COPY/MOVE 到回收站 = 软删除（Apple Mail 删除流程第一步）
cli.reset();
cli.send('a5 SELECT INBOX\r\n');
ok('SELECT', !!(await cli.waitFor(b => b.includes('a5 '))));
extensionAdapter.deleteCalls.length = 0;
cli.reset();
cli.send('a6 UID COPY 1 Trash\r\n');
const r6 = await cli.waitFor(b => b.includes('a6 '));
ok('UID COPY Trash 回 OK（COPYUID uid 不变）',
  !!r6 && /a6 OK/.test(r6) && r6.includes('[COPYUID 1 1 1]'), r6 ? r6.trim() : '');
ok('COPY Trash 落一次软删除', extensionAdapter.deleteCalls.length === 1, JSON.stringify(extensionAdapter.deleteCalls));
cli.reset();
cli.send('a6b COPY 1 Sent\r\n');
const r6b = await cli.waitFor(b => b.includes('a6b '));
ok('COPY 到非回收站仍回 NO（移动不做）', !!r6b && /a6b NO/.test(r6b), r6b ? r6b.trim() : '');

// [v0.2.23] COPY/MOVE 到 Junk = 站内标垃圾（只对收件箱成立，失败要回 tagged NO 而非 BAD）
cli.reset();
cli.send('a6c UID COPY 1 Junk\r\n');
const rJunk = await cli.waitFor(b => b.includes('a6c '));
ok('UID COPY Junk 回 OK（COPYUID）',
  !!rJunk && /a6c OK/.test(rJunk) && rJunk.includes('[COPYUID 1 1 1]'), rJunk ? rJunk.trim() : '');
ok('COPY Junk 落一次标记垃圾', extensionAdapter.spamCalls.length === 1, JSON.stringify(extensionAdapter.spamCalls));
extensionAdapter.failSpam = true;
cli.reset();
cli.send('a6d UID COPY 1 Junk\r\n');
const rJunkFail = await cli.waitFor(b => b.includes('a6d '));
ok('补丁 26：标记垃圾失败回 tagged NO（不是 * BAD）',
  !!rJunkFail && /a6d NO/.test(rJunkFail) && rJunkFail.includes('只有收件箱邮件'),
  rJunkFail ? rJunkFail.trim() : '');
ok('补丁 26：失败不是内部错误', !!/a6d NO/.test(rJunkFail || '') && !/\* BAD/.test(rJunkFail || ''), rJunkFail || '');
extensionAdapter.failSpam = false;

// 补丁 24：STORE \Deleted 必须传 deletedAt（否则客户端删完一刷新又回来）
cli.reset();
cli.send('a7 UID STORE 1 +FLAGS (\\Deleted)\r\n');
const r8 = await cli.waitFor(b => b.includes('a7 '));
ok('STORE +\\Deleted 回 OK', !!r8 && /a7 OK/.test(r8), r8 ? r8.trim() : '');
ok('补丁 24：+\\Deleted → deletedAt=true（软删除）',
  messageAdapter.flagCalls.length === 1 && messageAdapter.flagCalls[0].deletedAt === true,
  JSON.stringify(messageAdapter.flagCalls));
cli.reset();
cli.send('a8 UID STORE 1 -FLAGS (\\Deleted)\r\n');
await cli.waitFor(b => b.includes('a8 '));
ok('补丁 24：-\\Deleted → deletedAt=false（不触发删除）',
  messageAdapter.flagCalls.length === 2 && messageAdapter.flagCalls[1].deletedAt === false,
  JSON.stringify(messageAdapter.flagCalls));
cli.reset();
cli.send('a9 UID STORE 1 +FLAGS (\\Seen)\r\n');
await cli.waitFor(b => b.includes('a9 '));
ok('补丁 24：只改 \\Seen 不带 deletedAt',
  messageAdapter.flagCalls.length === 3 && messageAdapter.flagCalls[2].deletedAt === false,
  JSON.stringify(messageAdapter.flagCalls));

// 会话级 EXPUNGE：STORE \Deleted 之后 EXPUNGE 必须吐 * n EXPUNGE（补丁 27）
cli.reset();
cli.send('a9c UID STORE 1 +FLAGS (\\Deleted)\r\n');
await cli.waitFor(b => b.includes('a9c '));
cli.reset();
cli.send('a9d UID EXPUNGE 1\r\n');
const rExp = await cli.waitFor(b => b.includes('a9d '));
ok('UID EXPUNGE 带 * n EXPUNGE（回收站的信不带 \\Deleted 也能回删除应答）',
  !!rExp && /a9d OK/.test(rExp) && /\* \d+ EXPUNGE/.test(rExp), rExp ? rExp.trim() : '');

// MOVE（放在 STORE 之后：MOVE 会把 uid 1 从会话里弹掉，影响后续命令）
cli.reset();
cli.send('a10 UID MOVE 2 Trash\r\n');
const r7b = await cli.waitFor(b => b.includes('a10 '));
ok('UID MOVE Trash 回 OK 且带 EXPUNGE',
  !!r7b && /a10 OK/.test(r7b) && /\* \d+ EXPUNGE/.test(r7b), r7b ? r7b.trim() : '');
ok('MOVE Trash 也落软删除', extensionAdapter.deleteCalls.length === 2, JSON.stringify(extensionAdapter.deleteCalls));

await cli.sock.destroy();

// [v0.2.27] 跨会话 EXPUNGE：新连接里没有会话记录，靠「实时 UID 列表」判定
const cli2 = makeClient(server.port);
ok('新连接问候', !!(await cli2.waitFor(b => b.includes('* OK'))));
cli2.send('b1 LOGIN "' + MAILBOX + '" "pwd"\r\n');
ok('新连接 LOGIN', !!(await cli2.waitFor(b => b.includes('b1 OK'))));
cli2.reset();
cli2.send('b2 SELECT INBOX\r\n');
ok('新连接 SELECT', !!(await cli2.waitFor(b => b.includes('b2 '))));
mailboxAdapter.hidden.add(2); // 模拟这封信已被移走
cli2.reset();
cli2.send('b3 EXPUNGE\r\n');
const rCross = await cli2.waitFor(b => b.includes('b3 '));
ok('跨会话 EXPUNGE 靠实时 UID 列表回 * n EXPUNGE',
  !!rCross && /b3 OK/.test(rCross) && /\* 2 EXPUNGE/.test(rCross), rCross ? rCross.trim() : '');
ok('仍在文件夹里的 uid1 不被误删',
  !!rCross && !/\* 1 EXPUNGE/.test(rCross), rCross || '');
await cli2.sock.destroy();
server.close();

console.log(`\n[verify-append] ${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  console.error('[verify-append] 失败项：\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
