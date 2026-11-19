/**
 * [S37] literal 线上探测（只读）：验证 CAPABILITY 宣告的 LITERAL+ 与同步 literal 是否真的可用。
 *
 * 为什么单独一个脚本：send()/等 tag 模式看不到中间那个 "+ " 续传提示，
 * 而「回不回 +」正是判断同步/非同步 literal 是否实现的关键。
 *
 * 用法：
 *   node scripts/probe-literal.mjs --host imap.example.com --port 993 \
 *        --user you@example.com --pass <应用密码>
 */
import tls from 'node:tls';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const HOST = arg('host', '127.0.0.1');
const PORT = Number(arg('port', 993));
const USER = arg('user', 'you@example.com');
const PASS = arg('pass', '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tagSeq = 0;
let barrierSeq = 0;

const sock = tls.connect({ host: HOST, port: PORT, servername: 'imap.example.com', rejectUnauthorized: false });
sock.on('error', (e) => { console.log('[连接失败]', e.message); process.exit(1); });
setTimeout(() => { console.log('[超时] 60 秒内未完成'); process.exit(1); }, 60000).unref?.();

let buf = '';
let healthy = true;
sock.on('data', (d) => { buf += d; });
sock.setEncoding('utf8');

const waitFor = async (pred, ms = 5000) => {
  const t0 = Date.now();
  for (;;) {
    if (pred(buf)) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(20);
  }
};

const mark = (label, okFlag, detail) => {
  if (!okFlag) healthy = false;
  console.log(`   ${okFlag ? '✓' : '✗'} ${label}${detail ? `  ← ${detail}` : ''}`);
};

/* CHECK 是纯 no-op（立即回 OK），拿它当屏障能确保上一条命令的响应已经排空，
   避免把上一条的 * SEARCH / OK 串到这一条的 buf 里误判。 */
async function barrier() {
  const t = `B${++barrierSeq}`;
  buf = '';
  sock.write(`${t} CHECK\r\n`);
  await waitFor((b) => b.includes(`${t} OK`), 15000);
  buf = '';
}

/* 三种 literal：同步 ASCII、非同步 ASCII、同步中文（多字节，长度必须按字节算） */
async function literal(label, command, content, synchronous) {
  const tag = `L${++tagSeq}`;
  const bytes = Buffer.from(content, 'utf8');
  await barrier();
  let sawContinuation = false;
  if (synchronous) {
    sock.write(`${tag} ${command} {${bytes.length}}\r\n`);
    sawContinuation = await waitFor((b) => b.includes('+ '), 3000);
    sock.write(Buffer.concat([bytes, Buffer.from('\r\n')]));
  } else {
    // LITERAL+ 的真实语义就是「不等 + 直接发」，而且客户端通常一个 TCP 段里发完。
    // 分两次 write 会人为制造一个 300ms 窗口，反而测不出真实行为。
    const wire = `${tag} ${command} {${bytes.length}+}\r\n${content}\r\n`;
    sock.write(wire);
    await sleep(150);
    sawContinuation = buf.includes('+ ');
  }
  await waitFor((b) => b.includes(`${tag} OK`) || b.includes(`${tag} NO`) || b.includes(`${tag} BAD`), 8000);
  await sleep(200);

  const text = buf;
  console.log(`\n### ${label}`);
  if (synchronous) {
    mark('同步 literal 返回 "+" 续传提示', sawContinuation);
  } else {
    mark('非同步 literal 不返回 "+"（LITERAL+ 语义）', !sawContinuation, sawContinuation ? '服务端仍回 +，等于没实现 LITERAL+' : '');
  }
  mark('命令正常完成（未报 BAD）', !text.includes(`${tag} BAD`), text.includes(`${tag} BAD`) ? '收到 BAD' : '');
  mark('未产生残留 BAD 污染', !text.includes('* BAD'));
  if (text.includes('* BAD')) console.log('   [RAW] ' + JSON.stringify(text));
  const searchLine = (text.match(/\* SEARCH[^\r\n]*/g) || []).join(' / ');
  console.log(`   应答摘要：${searchLine || '(无 SEARCH 行)'} | ${text.includes(`${tag} OK`) ? 'OK' : text.includes(`${tag} NO`) ? 'NO' : '?'}`);
}

(async () => {
  if (!(await waitFor((b) => b.includes('* OK')))) {
    console.log('[失败] 未收到问候');
    process.exit(1);
  }
  console.log('=== 问候 ===\n' + buf.split('\r\n')[0]);

  buf = '';
  sock.write(`a1 LOGIN "${USER}" "${PASS}"\r\n`);
  if (!(await waitFor((b) => b.includes('a1 OK') || b.includes('a1 NO')))) {
    console.log('[失败] LOGIN 无应答');
    process.exit(1);
  }
  if (!buf.includes('a1 OK')) {
    console.log('[失败] LOGIN 被拒：' + buf.trim());
    process.exit(1);
  }
  console.log('=== LOGIN OK ===');

  buf = '';
  sock.write('a2 SELECT INBOX\r\n');
  await waitFor((b) => b.includes('a2 '), 20000);
  console.log(`=== SELECT：${(buf.match(/\* (\d+) EXISTS/) || [])[1] || '?'} 封 ===`);

  await literal('同步 literal（ASCII，主题含 hello）', 'UID SEARCH SUBJECT', 'hello', true);
  await literal('非同步 literal（ASCII，主题含 hello）', 'UID SEARCH SUBJECT', 'hello', false);
  await literal('同步 literal（中文，主题含 测试）', 'UID SEARCH SUBJECT', '测试', true);

  console.log(`\n${healthy ? '✅ 全部符合' : '❌ 存在不符项'}`);
  sock.write('a9 LOGOUT\r\n');
  await sleep(300);
  sock.end();
  process.exit(healthy ? 0 : 2);
})();
