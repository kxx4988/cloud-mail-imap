/**
 * [S37] 部分取（BODY[]<start.count>）字节精确性诊断
 *
 * IMAP 协议要求 `<start.count>` 必须精确返回 count 字节（末段不足除外）。
 * 少 1 字节 → 客户端按请求长度拼接时整体错位 → 正文整屏乱码。
 *
 * 用法：node scripts/diag-partial.mjs --host imap.example.com --port 993 --user .. --pass .. --uid 65 --part 2
 */
import tls from 'node:tls';

const argv = process.argv.slice(2);
function arg(name, def = '') {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}

const HOST = arg('host', 'imap.example.com');
const PORT = Number(arg('port', '993'));
const USER = arg('user', '');
const PASS = arg('pass', '');
const UID = arg('uid', '');
const PART = arg('part', '2');

if (!USER || !PASS || !UID) { console.error('需要 --user --pass --uid'); process.exit(2); }

const socket = tls.connect({ host: HOST, port: PORT, rejectUnauthorized: false });
socket.setEncoding('latin1');

let buf = '';
let greeting = '';
let greetingResolved = false;
let resolveGreeting = () => {};
const greetingReady = new Promise((r) => { resolveGreeting = r; });
const waiters = [];

socket.on('data', (chunk) => {
  buf += chunk;
  if (!greeting) {
    const nl = buf.indexOf('\r\n');
    if (nl >= 0) { greeting = buf.slice(0, nl + 2); buf = buf.slice(nl + 2); }
  }
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    const needle = `\r\n${w.tag} `;
    let end = buf.indexOf(needle);
    if (end < 0 && buf.startsWith(`${w.tag} `)) end = 0;
    if (end < 0) continue;
    const lineEnd = buf.indexOf('\r\n', end + (end === 0 ? 0 : 2));
    if (lineEnd < 0) continue;
    const block = buf.slice(0, lineEnd);
    buf = buf.slice(lineEnd + 2);
    waiters.splice(i, 1);
    w.resolve(block);
  }
  if (!greetingResolved && greeting) { greetingResolved = true; resolveGreeting(greeting); }
});

let seq = 0;
function cmd(command) {
  const tag = `p${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时：${command.slice(0, 50)}`)), 40000);
    waiters.push({ tag, resolve: (v) => { clearTimeout(timer); resolve({ tag, block: v }); } });
    socket.write(`${tag} ${command}\r\n`);
  });
}

// 从 FETCH 响应里抽所有 literal 段：{n} 前的内容作为 label
function literals(block) {
  const out = [];
  let i = 0;
  while (true) {
    const m = block.indexOf('{', i);
    if (m < 0) break;
    const close = block.indexOf('}\r\n', m);
    if (close < 0) break;
    const n = Number(block.slice(m + 1, close));
    if (!Number.isFinite(n)) break;
    const start = close + 3;
    const body = block.slice(start, start + n);
    const labelStart = block.lastIndexOf('\r\n', m);
    out.push({
      label: block.slice(labelStart < 0 ? 0 : labelStart + 2, m).trim(),
      declared: n,
      actual: Buffer.byteLength(body, 'latin1'),
    });
    i = start + n;
  }
  return out;
}

(async () => {
  await new Promise((res, rej) => {
    socket.once('secureConnect', res);
    socket.once('error', rej);
  });
  await Promise.race([greetingReady, new Promise((r) => setTimeout(r, 5000))]);

  const li = await cmd(`LOGIN ${USER} ${PASS}`);
  console.log('LOGIN:', li.block.split('\r\n').pop());
  const se = await cmd('SELECT "INBOX"');
  console.log('SELECT:', se.block.split('\r\n').pop());

  // 1) 单独取三块，检查精确长度
  const cases = [[0, 1000], [1000, 1000], [2000, 2000], [4000, 5000]];
  for (const [start, count] of cases) {
    const r = await cmd(`UID FETCH ${UID} (BODY.PEEK[${PART}]<${start}.${count}>)`);
    const lits = literals(r.block);
    const tag = r.block.slice(r.block.lastIndexOf('\r\n') + 2);
    if (!lits.length) {
      console.log(`  <${start}.${count}> → 无 literal  ${tag}`);
      continue;
    }
    for (const l of lits) {
      const ok = l.actual === count;
      console.log(`  <${start}.${count}> → 声明 ${l.declared} / 实际 ${l.actual} / ${ok ? '长度精确 ✓' : '长度不符 ✗'}`);
      console.log(`    标签：${l.label}`);
    }
  }

  // 2) 一次命令多个部分（客户端常这样批量）
  const r2 = await cmd(`UID FETCH ${UID} (BODY.PEEK[${PART}]<0.1000> BODY.PEEK[${PART}]<1000.1000>)`);
  console.log('\n 多段一次取：');
  for (const l of literals(r2.block)) {
    console.log(`    ${l.label} → 声明 ${l.declared} / 实际 ${l.actual} ${l.actual === 1000 ? '✓' : '✗'}`);
  }

  await cmd('LOGOUT');
  socket.end();
})().catch((e) => { console.error('异常：', e.message); process.exit(1); });
