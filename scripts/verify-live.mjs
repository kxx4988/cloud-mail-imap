/**
 * [S37] 线上联调：SMTP 发一封 → IMAP 用 NOOP 轮询，验证 `* n EXISTS` 真的会推。
 *
 * 覆盖 v0.2.15 的 N2/N3：NOOP 不查库、IDLE 不推送时，客户端只能等超时重连。
 *
 * 用法：
 *   node scripts/verify-live.mjs --host imap.example.com --user you@example.com --pass <应用密码>
 */
import tls from 'node:tls';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const HOST = arg('host', 'imap.example.com');
const PORT = Number(arg('port', 993));
const SMTP_PORT = Number(arg('smtp-port', 465));
const USER = arg('user', 'you@example.com');
const PASS = arg('pass', '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${extra ? `  ← ${extra}` : ''}`); }
};

/* ------------------------------------------------------------------ SMTP 发信 */
async function sendMail(subject) {
  const sock = tls.connect({ host: HOST, port: SMTP_PORT, servername: 'imap.example.com', rejectUnauthorized: false });
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', (d) => { buf += d; });
  const waitFor = async (pred, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      if (pred(buf)) return true;
      if (Date.now() - t0 > ms) return false;
      await sleep(30);
    }
  };
  const step = async (line, pred, label) => {
    buf = '';
    sock.write(line);
    const got = await waitFor(pred);
    if (!got) throw new Error(`SMTP ${label} 失败：${JSON.stringify(buf)}`);
    return buf;
  };

  await waitFor((b) => b.startsWith('220'), 15000);
  await step('EHLO verify.local\r\n', (b) => b.includes('250 '), 'EHLO');
  const cred = Buffer.from(`\u0000${USER}\u0000${PASS}`, 'utf8').toString('base64');
  await step(`AUTH PLAIN ${cred}\r\n`, (b) => /^235/m.test(b), 'AUTH');
  await step(`MAIL FROM:<${USER}>\r\n`, (b) => /^250/m.test(b), 'MAIL');
  await step(`RCPT TO:<${USER}>\r\n`, (b) => /^25[01]/m.test(b), 'RCPT');

  const mail = [
    `From: ${USER}`,
    `To: ${USER}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    '这是 IMAP 网关 NOOP 推送自检邮件，可删除。',
    '',
  ].join('\r\n');
  await step('DATA\r\n', (b) => b.startsWith('354'), 'DATA');
  await step(`${mail}\r\n.\r\n`, (b) => /^250/m.test(b), 'DATA-BODY');
  sock.write('QUIT\r\n');
  await sleep(300);
  sock.end();
}

/* --------------------------------------------------------------- IMAP 侧观察 */
const imap = tls.connect({ host: HOST, port: PORT, servername: 'imap.example.com', rejectUnauthorized: false });
imap.setEncoding('utf8');
let ibuf = '';
imap.on('data', (d) => { ibuf += d; });
const iwait = async (pred, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    if (pred(ibuf)) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(40);
  }
};

await iwait((b) => b.includes('* OK'));
ibuf = '';
imap.write(`i1 LOGIN "${USER}" "${PASS}"\r\n`);
await iwait((b) => b.includes('i1 OK'), 30000);
ok('IMAP 登录', ibuf.includes('i1 OK'), JSON.stringify(ibuf).slice(0, 160));

ibuf = '';
imap.write('i2 SELECT INBOX\r\n');
await iwait((b) => b.includes('i2 '), 30000);
const base = Number((ibuf.match(/\* (\d+) EXISTS/) || [])[1] || -1);
ok('SELECT 返回 EXISTS', base >= 0, `EXISTS=${base}`);
console.log(`     基线：INBOX ${base} 封`);

// 发信前 NOOP 不应推 EXISTS
ibuf = '';
imap.write('i3 NOOP\r\n');
await iwait((b) => b.includes('i3 '), 20000);
ok('无变化时 NOOP 不推 EXISTS', !/\* \d+ EXISTS/.test(ibuf), JSON.stringify(ibuf).slice(0, 160));

const subject = `cmimap-noop-test-${Date.now()}`;
console.log(`     发信：${subject}`);
await sendMail(subject);

let pushed = -1;
for (let i = 0; i < 12; i++) {
  ibuf = '';
  imap.write(`i4 NOOP\r\n`);
  await iwait((b) => b.includes('i4 '), 20000);
  const m = ibuf.match(/\* (\d+) EXISTS/);
  if (m && Number(m[1]) > base) { pushed = Number(m[1]); break; }
  await sleep(2500);
}
ok('新邮件到达后 NOOP 推送了新的 EXISTS', pushed === base + 1, `期望 ${base + 1}，实际 ${pushed}`);

// 新 UID 可检索，说明 uidMap 已重建
ibuf = '';
imap.write('i5 UID SEARCH ALL\r\n');
await iwait((b) => b.includes('i5 '), 30000);
const uids = ((ibuf.match(/\* SEARCH ([\d ]+)/) || [])[1] || '').trim().split(/\s+/).filter(Boolean);
ok('uidMap 已重建（UID 数量追平 EXISTS）', uids.length === base + 1, `UID 数 ${uids.length}`);

imap.write('i9 LOGOUT\r\n');
await sleep(300);
imap.end();

console.log(`\n${fails.length ? '❌' : '✅'} 线上联调：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
