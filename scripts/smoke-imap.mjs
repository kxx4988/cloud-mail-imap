/**
 * [S37] IMAP 冒烟测试：用真实账号把客户端最常发的命令跑一遍，逐条断言。
 *
 * 用法：
 *   node scripts/smoke-imap.mjs --host 127.0.0.1 --port 1993 \
 *        --user you@example.com --pass <应用密码> [--folder INBOX] [--limit 3]
 *
 * 每条断言都对应过一次线上故障：
 *   · CAPABILITY 声明了 NAMESPACE/ID 却不应答 → 客户端吃 BAD
 *   · NAMESPACE/ID 行尾少 CRLF → 和下一行粘成一行，客户端认不出 tag 直接卡死
 *   · CREATE 回 BAD 而非 NO → 客户端弹协议错误
 *   · RFC822.SIZE ≠ BODY[] 实际字节数 → 客户端判「邮件损坏」
 *   · BODYSTRUCTURE 段号与 BODY[n] 对不上 → 正文空白
 *   · UID FETCH 响应缺 UID → 永远「正在载入」
 */
import tls from 'node:tls';

const argv = process.argv.slice(2);
function arg(name, def = '') {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}

const HOST = arg('host', '127.0.0.1');
const PORT = Number(arg('port', '1993'));
const USER = arg('user', '');
const PASS = arg('pass', '');
const FOLDER = arg('folder', 'INBOX');
const LIMIT = Number(arg('limit', '3'));
const TIMEOUT = Number(arg('timeout', '30000'));

if (!USER || !PASS) {
  console.error('需要 --user 与 --pass（应用密码）');
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const socket = tls.connect({ host: HOST, port: PORT, rejectUnauthorized: false });
socket.setEncoding('latin1');

let buf = '';
let greeting = '';
let greetingResolved = false;
let resolveGreeting = () => {};
const greetingReady = new Promise((res) => { resolveGreeting = res; });
const waiters = [];
socket.on('data', (chunk) => {
  buf += chunk;
  if (!greeting) {
    const nl = buf.indexOf('\r\n');
    if (nl >= 0) {
      greeting = buf.slice(0, nl + 2);
      buf = buf.slice(nl + 2);
    }
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
  const tag = `t${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时：${command.slice(0, 40)}`)), TIMEOUT);
    waiters.push({ tag, resolve: (v) => { clearTimeout(timer); resolve({ tag, block: v }); } });
    socket.write(`${tag} ${command}\r\n`);
  });
}

function status(block) {
  const m = block.match(/\r?\n?(t\d+) (OK|NO|BAD) /);
  return m ? m[2] : '';
}

// 取 FETCH 响应里某个 BODY[...] 的字节数（latin1 下 1 字符 = 1 字节）
function literalSize(block, label) {
  const re = new RegExp(`${label}[^\\{]*\\{(\\d+)\\}\\r\\n`);
  const m = block.match(re);
  if (!m) return null;
  const idx = block.indexOf(`{${m[1]}}\r\n`, m.index) + m[1].length + 4;
  return { declared: Number(m[1]), actual: Buffer.byteLength(block.slice(idx, idx + Number(m[1])), 'latin1') };
}

// [v0.2.13] 取 FETCH 响应里某个 BODY[...] 的字面量内容（latin1 下 1 字符 = 1 字节）
function literalBody(block, label) {
  const re = new RegExp(`${label}[^\\{]*\\{(\\d+)\\}\\r\\n`);
  const m = block.match(re);
  if (!m) return null;
  const idx = block.indexOf(`{${m[1]}}\r\n`, m.index) + m[1].length + 4;
  return block.slice(idx, idx + Number(m[1]));
}

(async () => {
  await new Promise((res, rej) => {
    socket.once('secureConnect', res);
    socket.once('error', rej);
  });

  await Promise.race([greetingReady, new Promise((r) => setTimeout(r, 5000))]);
  console.log('▶ 握手 / 能力');
  check('greeting 含 IMAP4rev1', /IMAP4rev1/.test(greeting), greeting.trim());
  check('greeting 含 NAMESPACE', /NAMESPACE/.test(greeting));

  const cap = await cmd('CAPABILITY');
  check('CAPABILITY OK', status(cap.block) === 'OK');

  const ns = await cmd('NAMESPACE');
  check('NAMESPACE 回 OK（不是 BAD）', status(ns.block) === 'OK', ns.block.trim());
  check('NAMESPACE 独立成行（行尾有 CRLF）',
    /^\* NAMESPACE \(\("" "\/"\)\) NIL NIL$/.test(ns.block.split('\r\n')[0]), ns.block.split('\r\n')[0]);

  const idres = await cmd('ID ("name" "smoke")');
  check('ID 回 OK（不是 BAD）', status(idres.block) === 'OK');
  check('ID 独立成行', /^\* ID \(/.test(idres.block.split('\r\n')[0]));

  const checkRes = await cmd('CHECK');
  check('CHECK 回 OK', status(checkRes.block) === 'OK');

  console.log('▶ 登录 / 文件夹');
  const login = await cmd(`LOGIN ${USER} ${PASS}`);
  check('LOGIN OK', status(login.block) === 'OK', login.block.trim());
  if (status(login.block) !== 'OK') { socket.end(); process.exit(1); }

  const list = await cmd('LIST "" "*"');
  const listLines = list.block.split('\r\n').filter(l => l.startsWith('* LIST'));
  check('LIST ≥ 4 个文件夹', listLines.length >= 4, `${listLines.length} 个`);
  check('INBOX 存在', listLines.some(l => /\bINBOX\b/i.test(l)));
  check('Trash 带 \\Trash', listLines.some(l => /\\Trash/i.test(l)), '未声明特殊用途 → 客户端废纸篓行为异常');
  check('Junk 带 \\Junk', listLines.some(l => /\\Junk/i.test(l)));
  check('Sent 带 \\Sent', listLines.some(l => /\\Sent/i.test(l)));

  const create = await cmd('CREATE "smoke-test"');
  check('CREATE 回 NO（不谎报能力）', status(create.block) === 'NO', create.block.trim());

  const sel = await cmd(`SELECT "${FOLDER}"`);
  check('SELECT OK', status(sel.block) === 'OK', sel.block.trim());
  const exists = sel.block.match(/\* (\d+) EXISTS/);
  const count = exists ? Number(exists[1]) : 0;
  console.log(`  · ${FOLDER} 共 ${count} 封`);

  if (count > 0) {
    const search = await cmd('UID SEARCH ALL');
    const uids = (search.block.match(/\* SEARCH ([^\r\n]*)/) || [, ''])[1].trim().split(/\s+/).filter(Boolean).map(Number);
    check('UID SEARCH 有结果', uids.length > 0, `${uids.length} 个 UID`);

    const targets = uids.slice(-Math.min(LIMIT, count));
    console.log(`▶ 逐封校验（${targets.length} 封）`);
    for (const uid of targets) {
      const bs = await cmd(`UID FETCH ${uid} (BODYSTRUCTURE RFC822.SIZE)`);
      const block = bs.block;
      check(`UID ${uid} 响应带 UID`, new RegExp(`UID ${uid}`).test(block));
      const sizeM = block.match(/RFC822\.SIZE (\d+)/);
      check(`UID ${uid} 有 RFC822.SIZE`, !!sizeM);
      check(`UID ${uid} 有 BODYSTRUCTURE`, /BODYSTRUCTURE \(/.test(block));

      const rawRes = await cmd(`UID FETCH ${uid} (BODY.PEEK[])`);
      const lit = literalSize(rawRes.block, 'BODY\\[\\]');
      check(`UID ${uid} BODY[] 字节数 = RFC822.SIZE`,
        !!lit && !!sizeM && lit.actual === Number(sizeM[1]),
        lit && sizeM ? `声明 ${sizeM[1]} / 实际 ${lit.actual}` : '未取到字面量');

      const p1 = await cmd(`UID FETCH ${uid} (BODY.PEEK[1])`);
      const p1lit = literalSize(p1.block, 'BODY\\[1\\]');
      check(`UID ${uid} BODY[1] 非空`, !!p1lit && p1lit.actual > 0, p1lit ? `${p1lit.actual} 字节` : '空');

      // [v0.2.13] 段必须不带自己的 MIME 头：一旦以 Content- 开头，客户端会把段头里的
      // Content-Type / text / html / BASE64 当成 base64 数据解码 → 从头错位 → 整屏乱码。
      // 叶子段要求整段是纯 base64；multipart 段（以 --boundary 开头）内部本来就有子段头，只管"自己不带头"。
      function isCleanSeg(body) {
        if (!body || body.startsWith('Content-')) return false;
        if (body.startsWith('--')) return true; // multipart 段的正文
        return /^[A-Za-z0-9+/=\r\n]*$/.test(body);
      }
      const p1body = literalBody(p1.block, 'BODY\\[1\\]');
      check(`UID ${uid} BODY[1] 不带段头`,
        isCleanSeg(p1body), p1body ? JSON.stringify(p1body.slice(0, 40)) : '未取到字面量');

      const p2 = await cmd(`UID FETCH ${uid} (BODY.PEEK[2])`);
      const p2body = literalBody(p2.block, 'BODY\\[2\\]');
      if (p2body) {
        check(`UID ${uid} BODY[2] 不带段头`,
          isCleanSeg(p2body), JSON.stringify(p2body.slice(0, 40)));
      }
    }
  }

  const out = await cmd('LOGOUT');
  check('LOGOUT 正常', /OK|BYE/i.test(out.block));
  socket.end();

  console.log(`\n${fail === 0 ? '✅ 冒烟全部通过' : '❌ 有失败项'}：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(`冒烟异常：${e.message}`);
  try { socket.destroy(); } catch (err) { /* 忽略 */ }
  process.exit(1);
});
