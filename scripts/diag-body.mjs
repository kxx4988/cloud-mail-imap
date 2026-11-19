/**
 * [S37] 正文乱码诊断：定位是「源数据就乱」还是「我们编码后乱」
 *
 * 用法：node scripts/diag-body.mjs --user you@example.com --pass <应用密码> [--match Squarespace]
 */
import { login, listEmails, getDetail } from '../src/worker-client.js';
import { buildRfc822, buildTree } from '../src/mime.js';
import { extractSection } from '../src/sections.js';

const argv = process.argv.slice(2);
function arg(name, def = '') {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}

const USER = arg('user', '');
const PASS = arg('pass', '');
const MATCH = arg('match', '');
const LIMIT = Number(arg('limit', '3'));

if (!USER || !PASS) { console.error('需要 --user 与 --pass'); process.exit(2); }

function hasReplacement(s) {
  return String(s ?? '').includes('\uFFFD');
}

function isUtf8Fatal(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch (e) {
    return false;
  }
}

function b64clean(s) {
  return String(s ?? '').replace(/\r\n|\r|\n/g, '');
}

const list = await listEmails(USER, PASS, 'inbox');
console.log(`INBOX 共 ${list.length} 封`);
if (list[0]) console.log('list 条目字段：', Object.keys(list[0]).join(', '));

const picked = list.filter(e => !MATCH || String(e.subject || '').toLowerCase().includes(MATCH.toLowerCase()));
const targets = (picked.length ? picked : list).slice(0, LIMIT);

for (const item of targets) {
  const id = item.emailId;
  const detail = await getDetail(USER, PASS, id);
  if (!detail) { console.log(`\n#${id} 取不到 detail`); continue; }

  const html = String(detail.content || '');
  const text = String(detail.text || '');
  console.log(`\n================ #${id} ${JSON.stringify(detail.subject)} | ${detail.createTime} ================`);
  console.log(`html 长度 ${html.length} / utf8 字节 ${Buffer.byteLength(html, 'utf8')} / 含替换符 ${hasReplacement(html)}`);
  console.log(`text 长度 ${text.length} / utf8 字节 ${Buffer.byteLength(text, 'utf8')} / 含替换符 ${hasReplacement(text)}`);
  console.log(`附件 ${(detail.attList || []).length} 个：${(detail.attList || []).map(a => `${a.filename}(${a.mimeType},${a.size})`).join(' | ')}`);
  console.log(`html 原始前 200：${JSON.stringify(html.slice(0, 200))}`);

  // 生成的门户原文
  const raw = await buildRfc822(USER, PASS, detail);
  const tree = buildTree(detail);
  console.log(`raw 字节 ${Buffer.byteLength(raw, 'latin1')} / tree=${tree.kind}${tree.subtype ? ':' + tree.subtype : ''}`);

  // 段：单段 → 1；alternative → 1.1 / 1.2；alternative+related → 1.1 / 1.2.1
  const secs = tree.kind === 'multi'
    ? (tree.subtype === 'MIXED' ? ['1', '2'] : ['1', '2'])
    : ['1'];
  for (const sec of secs) {
    const seg = extractSection(raw, sec);
    const head = JSON.stringify(seg.slice(0, 120));
    // v0.2.13 起 BODY[n] 就是该段正文（不含 MIME 头），整段都是 base64
    const buf = Buffer.from(b64clean(seg), 'base64');
    const okUtf8 = isUtf8Fatal(buf);
    const decoded = buf.toString('utf8');
    console.log(`  BODY[${sec}] 段字节 ${seg.length} / base64 解码后 ${buf.length} / 合法UTF8=${okUtf8} / 含替换符=${hasReplacement(decoded)}`);
    console.log(`    头：${head}`);
    console.log(`    解码前 160：${JSON.stringify(decoded.slice(0, 160))}`);
  }
}
