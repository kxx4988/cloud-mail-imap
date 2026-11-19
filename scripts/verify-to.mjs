/**
 * [v0.2.17] 已发送收件人自检
 *
 * 背景：站内 saveSentEmail() 只写 recipient（JSON），to_email / to_name 恒为空，
 * 库的 buildEnvelope 用 toEmail 拼 ENVELOPE → 客户端看到「没有收件人」的已发送邮件。
 *
 * 覆盖：
 *   · recipient 解析与异常输入
 *   · toMessageData 的兜底（已发送 / 收件箱 / 多收件人 / 全空）
 *   · RFC822 原文的 To 头
 *   · RFC822.SIZE 与原文实际字节严格一致（BODYSTRUCTURE 取段错位的老坑）
 *   · 端到端：真实 socket FETCH ENVELOPE / BODY[HEADER]
 *
 * 用法：node scripts/verify-to.mjs
 */
import net from 'node:net';
import { createImapServer } from '@rafters/mail-imap-server';
import { parseRecipientList, toHeaderValue, buildRfc822, computeMeta } from '../src/mime.js';
import { toMessageData } from '../src/adapters.js';

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

/* -------------------------------------------------------------- 测试数据 */

const MAILBOX = 'you@example.com';
// 与线上 email_id 428 完全同形：type=1 已发送、to_email/to_name 空、recipient 有地址
const sentRow = {
  emailId: 428,
  type: 1,
  sendEmail: 'you@example.com',
  name: 'macos',
  toEmail: '',
  toName: '',
  recipient: '[{"address":"user@gmail.com","name":""}]',
  subject: 'Re: 测试',
  text: 'hi',
  createTime: '2026-11-12T10:03:36Z',
  unread: 1,
  isStar: 0,
  attList: [],
};

const inboxRow = {
  ...sentRow,
  emailId: 500,
  type: 0,
  toEmail: 'you@example.com',
  toName: 'admin',
  recipient: '[{"address":"someone@else.com","name":""}]',
};

/* ------------------------------------------------------ 1. recipient 解析 */

console.log('[1] recipient 解析');
ok('单地址解析', JSON.stringify(parseRecipientList(sentRow.recipient)) === '[{"address":"user@gmail.com","name":""}]');
ok('带显示名解析', parseRecipientList('[{"address":"a@x.com","name":"张三"}]')[0].name === '张三');
ok('空字符串不炸', parseRecipientList('').length === 0);
ok('非法 JSON 不炸', parseRecipientList('{[bad').length === 0);
ok('null 不炸', parseRecipientList(null).length === 0);
ok('缺 address 的项被过滤', parseRecipientList('[{"name":"x"}]').length === 0);

console.log('[2] To 头取值');
ok('to_email 为空时用 recipient', toHeaderValue(sentRow) === 'user@gmail.com');
ok('to_email 有值时优先它', toHeaderValue(inboxRow) === 'you@example.com');
ok('多收件人逗号连接',
  toHeaderValue({ toEmail: '', recipient: '[{"address":"a@x.com","name":""},{"address":"b@y.com","name":""}]' }) === 'a@x.com, b@y.com');
ok('带名字用 RFC2047 编码',
  toHeaderValue({ toEmail: '', recipient: '[{"address":"a@x.com","name":"张三"}]' }).startsWith('=?UTF-8?B?'));
ok('全空返回空串', toHeaderValue({ toEmail: '', recipient: '[]' }) === '');

/* --------------------------------------------------- 3. toMessageData 兜底 */

console.log('[3] toMessageData');
const sentMsg = toMessageData(sentRow);
ok('已发送：toEmail 从 recipient 还原', sentMsg.toEmail === 'user@gmail.com', JSON.stringify(sentMsg.toEmail));
ok('已发送：toName 保持 null（站内 name 是空串）', sentMsg.toName === null, JSON.stringify(sentMsg.toName));
ok('已发送：仍标记为 outbound', sentMsg.isOutbound === true);

const inboxMsg = toMessageData(inboxRow);
ok('收件箱：to_email 不被 recipient 覆盖', inboxMsg.toEmail === 'you@example.com', JSON.stringify(inboxMsg.toEmail));
ok('收件箱：toName 正常编码', inboxMsg.toName === 'admin');

const multiMsg = toMessageData({
  ...sentRow,
  recipient: '[{"address":"a@x.com","name":""},{"address":"b@y.com","name":""}]',
});
ok('多收件人：ENVELOPE 取第一个（库只支持单 to）', multiMsg.toEmail === 'a@x.com', JSON.stringify(multiMsg.toEmail));

const emptyMsg = toMessageData({ ...sentRow, recipient: '[]' });
ok('全空：toEmail 为空串而不是 undefined', emptyMsg.toEmail === '', JSON.stringify(emptyMsg.toEmail));

/* ------------------------------------------- 4. RFC822 原文与 size 一致性 */

console.log('[4] RFC822 原文');
const raw = await buildRfc822(MAILBOX, 'pwd', { ...sentRow, recipient: sentRow.recipient });
ok('原文包含 To: 收件人地址', raw.includes('To: user@gmail.com'), raw.split('\r\n')[1]);
ok('原文不含空的 To: 行', !/^To: \r$/m.test(raw));
ok('RFC822.SIZE 与原文实际字节一致',
  computeMeta({ ...sentRow, attList: [] }).sizeBytes === Buffer.byteLength(raw, 'utf8'),
  `${computeMeta({ ...sentRow, attList: [] }).sizeBytes} vs ${Buffer.byteLength(raw, 'utf8')}`);

const rawEmpty = await buildRfc822(MAILBOX, 'pwd', { ...sentRow, recipient: '[]', toEmail: '', attList: [] });
ok('无收件人时 To 为空但仍可控（不崩）', /^To: ?\r$/m.test(rawEmpty));

/* ------------------------------------------------------ 5. 端到端 ENVELOPE */

console.log('[5] 端到端 FETCH');
const FOLDER_ID = `sent:${MAILBOX}`;
const server = createImapServer({
  adapters: {
    authAdapter: { async verifyAppPassword(e, p) { return String(e).toLowerCase() === MAILBOX && p === 'pwd'; } },
    mailboxAdapter: {
      async listFolders() { return [{ id: FOLDER_ID, name: 'Sent', slug: 'sent' }]; },
      async getFolderByName(_mb, name) {
        if (String(name).toUpperCase() !== 'SENT') return undefined;
        return { id: FOLDER_ID, name: 'Sent', slug: 'sent' };
      },
      async getFolderStats() {
        return { messages: 1, recent: 0, unseen: 0, uidValidity: 1, uidNext: 429, flags: ['\\Seen'], permanentFlags: ['\\Seen'] };
      },
      // uid 必须与 message.id（`emailId:email`）里的 emailId 一致，否则库匹配不到消息、FETCH 只回 OK
      async getMessageUids() { return [{ uid: 428, messageId: `428:${MAILBOX}` }]; },
    },
    messageAdapter: {
      async getMessage() { return { ...toMessageData({ ...sentRow, _imapEmail: MAILBOX }), flags: ['\\Seen'] }; },
      async getMessagesByIds() { return [await this.getMessage()]; },
      async searchMessages() { return [`428:${MAILBOX}`]; },
      async updateMessageFlags() {},
      async deleteMessage() {},
      async getBlob() { return raw; },
      async getSection() { return undefined; },
    },
  },
  host: '127.0.0.1',
  port: 0,
  maxConnections: 2,
  sessionTimeoutMs: 20_000,
  async resolveMailboxId(email) { return String(email).toLowerCase(); },
});
await server.listen();

const sock = net.connect(server.port, '127.0.0.1');
let buf = '';
sock.setEncoding('utf8');
// RAW=1 时打印原始报文，排查协议层问题时用（默认安静）
const RAW = process.env.RAW === '1';
sock.on('data', (d) => {
  if (RAW) console.log('[recv]', JSON.stringify(d));
  buf += d;
});
async function waitFor(pred, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    if (pred(buf)) return buf;
    if (Date.now() - t0 > ms) return null;
    await new Promise(r => setTimeout(r, 10));
  }
}

ok('问候正常', !!(await waitFor(b => b.includes('* OK'))));
buf = '';
sock.write(`a1 LOGIN "${MAILBOX}" "pwd"\r\n`);
ok('LOGIN 成功', !!(await waitFor(b => b.includes('a1 OK'))));
buf = '';
sock.write('a2 SELECT Sent\r\n');
ok('SELECT Sent', !!(await waitFor(b => b.includes('a2 OK'))));

buf = '';
sock.write('a3 UID FETCH 428 ENVELOPE\r\n');
const rEnv = await waitFor(b => b.includes('a3 '));
ok('FETCH ENVELOPE 完成', !!rEnv && rEnv.includes('a3 OK'), rEnv ? JSON.stringify(rEnv).slice(0, 160) : 'timeout');
ok('ENVELOPE 的 To 含收件人 mailbox/host',
  !!rEnv && /"user"\s+"gmail\.com"/.test(rEnv),
  rEnv ? JSON.stringify(rEnv).slice(0, 300) : '');
ok('ENVELOPE 的 To 不再是空地址',
  !!rEnv && !/\(\(NIL NIL "" ""\)\)/.test(rEnv));

buf = '';
sock.write('a4 UID FETCH 428 BODY[HEADER]\r\n');
const rHdr = await waitFor(b => b.includes('a4 '));
ok('FETCH BODY[HEADER] 完成', !!rHdr && rHdr.includes('a4 OK'), rHdr ? 'timeout' : '');
ok('BODY[HEADER] 的 To 头带地址', !!rHdr && rHdr.includes('To: user@gmail.com'));

buf = '';
sock.write('a5 LOGOUT\r\n');
await waitFor(b => b.includes('a5 OK'));
sock.end();
await server.close();

console.log(`\n${fails.length ? '❌' : '✅'} 收件人自检：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.log('   - ' + f);
  process.exit(1);
}
