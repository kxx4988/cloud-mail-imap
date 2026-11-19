// [S37] 协议一致性探测：把「声明 vs 实现」的每一项都打一遍原始应答，供人工比对 RFC。
// 只读：全部用 BODY.PEEK / SEARCH / STATUS，不做任何写操作。
import tls from 'node:tls';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const HOST = arg('host', '127.0.0.1');
const PORT = Number(arg('port', 1993));
const USER = arg('user', 'you@example.com');
const PASS = arg('pass', '');
const reject = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ? false : false;

const sock = tls.connect({ host: HOST, port: PORT, servername: 'imap.example.com', rejectUnauthorized: reject });
let buf = '';
let waiters = [];
let tagN = 0;

// 用 utf8 解码：这样才能分辨「服务端发的是 RFC 2047 encoded-word（纯 ASCII）」还是
// 「裸 UTF-8 字节」（后者在客户端按 latin1/ASCII 解析 → 中文主题乱码）。
sock.setEncoding('utf8');
sock.on('data', (d) => {
  buf += d;
  for (const w of [...waiters]) {
    // 必须整行切：tagged 应答是「tag OK <text>\r\n」，只切到 tag 前缀会把剩余文本留在缓冲里污染下一条。
    const needle = `\r\n${w.tag} `;
    let start = buf.indexOf(needle);
    if (start >= 0) start += 2;
    else if (buf.startsWith(`${w.tag} `)) start = 0;
    if (start >= 0) {
      const eol = buf.indexOf('\r\n', start);
      const end = eol === -1 ? buf.length : eol + 2;
      const block = buf.slice(0, end);
      buf = buf.slice(end);
      waiters = waiters.filter((x) => x !== w);
      w.resolve(block);
    }
  }
});

const ready = new Promise((res) => {
  const check = () => (buf.includes('\r\n') || buf.startsWith('*') ? res() : setTimeout(check, 20));
  check();
});

function send(line, ms = 20000) {
  const tag = `p${++tagN}`;
  sock.write(`${tag} ${line}\r\n`);
  return new Promise((resolve) => {
    const w = { tag };
    w.resolve = (v) => { clearTimeout(t); resolve(v); };
    const t = setTimeout(() => {
      waiters = waiters.filter((x) => x !== w);
      resolve(`[TIMEOUT] ${buf.slice(-300)}`);
    }, ms);
    waiters.push(w);
  });
}
const sendRaw = (line, ms = 20000) => send(line, ms); // 同一入口，保留可读性

const log = (title, block, keep = 12) => {
  const lines = String(block).replace(/\r\n/g, '\n').trimEnd().split('\n');
  console.log(`\n### ${title}`);
  for (const l of lines.slice(0, keep)) console.log('   ' + (l.length > 190 ? l.slice(0, 190) + '…' : l));
  if (lines.length > keep) console.log(`   …(${lines.length - keep} 行省略)`);
};

(async () => {
  await ready;
  log('问候', buf);
  buf = '';

  log('CAPABILITY', await send('CAPABILITY'));
  log('LIST "" "*"', await send('LIST "" "*"'));
  log('LSUB "" "*"', await send('LSUB "" "*"'));
  log('LOGIN', await send(`LOGIN ${USER} ${PASS}`, 40000), 3);

  const sel = await send('SELECT "INBOX"', 40000);
  log('SELECT INBOX（完整应答）', sel, 30);

  log('EXAMINE INBOX', await send('EXAMINE "INBOX"', 40000), 30);

  log('STATUS 全部项', await send('STATUS "INBOX" (MESSAGES RECENT UIDNEXT UIDVALIDITY UNSEEN)'));
  log('STATUS 单项', await send('STATUS "INBOX" (UNSEEN)'));

  const st = await send('STATUS "INBOX" (MESSAGES)');
  const nmsg = Number((st.match(/\* STATUS .*MESSAGES (\d+)/i) || [])[1] || 0);
  if (nmsg > 0) {
    const one = await send('UID FETCH 1:* (UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE)', 60000);
    log('UID FETCH 1:* (UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE) 首封', one, 6);
    log('ENVELOPE 字段数检查', one.split('\n').find((l) => /ENVELOPE/.test(l)) || '(无)', 2);
  }

  // 段语义：大小写 / NOT / 未知 / 越界
  const allSearch = await send('UID SEARCH ALL', 45000);
  const uids = (allSearch.match(/\* SEARCH ([\d ]+)/) || [])[1] || '';
  const firstUid = uids.trim().split(/\s+/)[0] || '1';
  console.log(`\n[探测用 UID = ${firstUid}]`);
  for (const sec of ['', 'TEXT', 'HEADER', 'HEADER.FIELDS (SUBJECT FROM)',
    'HEADER.FIELDS.NOT (SUBJECT)', '1', '1.MIME', '1.mime', '1.TEXT', '1.text',
    '1.HEADER.FIELDS (CONTENT-TYPE)', '1.2', '1.2.MIME', '9.9', 'BOGUS']) {
    const r = await send(`UID FETCH ${firstUid} (BODY.PEEK[${sec}])`, 45000);
    const m = r.match(/BODY\[[^\]]*\]\s*\{(\d+)\}\r\n/);
    let lit = '';
    if (m) {
      const from = m.index + m[0].length;
      lit = r.slice(from, from + Number(m[1]));
    }
    const looksLikeHeader = /^[A-Za-z-]+:/.test(lit);
    log(`UID FETCH ${firstUid} BODY.PEEK[${sec}]`,
      `${m ? m[1] + 'B' : '未取到'} ${looksLikeHeader ? '[以头开头!!]' : ''} ${JSON.stringify(lit.slice(0, 40))}`, 2);
  }

  // ENVELOPE 各字段（非 ASCII 主题/发件人是否按 RFC 2047 编码）
  const env = await send(`UID FETCH ${firstUid} (ENVELOPE)`, 45000);
  const envLine = env.split('\r\n').find((l) => l.includes('ENVELOPE')) || '';
  log('ENVELOPE 原文', envLine, 2);
  console.log(`   -> 含 encoded-word(=?UTF-8?) : ${/=\?utf-8\?/i.test(envLine)}`);
  console.log(`   -> 含裸非 ASCII 字符       : ${/[\u0080-\uffff]/.test(envLine)}`);

  // SEARCH 条件
  for (const c of ['ALL', 'UNSEEN', 'SEEN', 'FLAGGED', 'NOT UNSEEN', 'SUBJECT "a"',
    'SINCE 1-Jan-2026', 'SINCE 1-Jan-2027', 'BEFORE 1-Jan-2027', 'BEFORE 1-Jan-2020',
    'LARGER 1000', 'LARGER 60000', 'SMALLER 1000', 'SMALLER 700',
    'OR UNSEEN FLAGGED', 'FROM "a"', 'HEADER SUBJECT "a"', 'UNANSWERED', 'UNDELETED',
    'ANSWERED', 'DELETED', 'DRAFT', 'KEYWORD FOO', 'UNKEYWORD FOO',
    'BCC "x"', 'CC "x"', 'TEXT "squarespace"', 'BODY "squarespace"']) {
    const r = await send(`UID SEARCH ${c}`, 45000);
    const line = r.split('\r\n').find((l) => l.startsWith('* SEARCH')) || r.split('\r\n')[0];
    const cnt = line.startsWith('* SEARCH') ? line.trim().split(/\s+/).length - 2 : -1;
    log(`UID SEARCH ${c}`, `命中 ${cnt} 封 :: ${(line || '').slice(0, 70)}`, 2);
  }

  // 写命令的拒绝方式（用不存在的目标，确保不会真写）
  log('APPEND', await send('APPEND "NoSuchBox" {5}\r\nhello', 20000), 4);
  log('COPY（不存在目标）', await send('UID COPY 1 "NoSuchBox"'), 4);
  log('MOVE（不存在目标）', await send('UID MOVE 1 "NoSuchBox"'), 4);
  // UID EXPUNGE 用「不存在的 UID」探测：协议应答必须存在，且不能误删任何真实邮件
  log('UID EXPUNGE 999999（不存在）', await send('UID EXPUNGE 999999', 30000), 4);
  log('UID EXPUNGE 空参数', await send('UID EXPUNGE', 15000), 2);
  log('CREATE', await send('CREATE "tmpbox"'), 3);
  log('SUBSCRIBE', await send('SUBSCRIBE "INBOX"'), 3);
  log('CHECK', await send('CHECK'), 3);
  log('NAMESPACE', await send('NAMESPACE'), 3);
  log('ID', await send('ID ("name" "probe")'), 3);
  log('小写命令 select', await send('select "INBOX"', 40000), 4);
  // 此时会话是 READ-WRITE（前面 EXAMINE 的只读已被这次 SELECT 覆盖），才能测 UID EXPUNGE
  const t0 = Date.now();
  log('UID EXPUNGE 1:*（读写会话，全量集合性能）', await send('UID EXPUNGE 1:*', 90000), 6);
  console.log(`   -> 耗时 ${Date.now() - t0}ms`);
  log('UID EXPUNGE 999999', await send('UID EXPUNGE 999999', 30000), 4);

  console.log('\n=== 探测结束 ===');
  sock.write('p999 LOGOUT\r\n');
  setTimeout(() => { sock.destroy(); process.exit(0); }, 600);
})();
