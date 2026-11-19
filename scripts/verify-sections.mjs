/**
 * [S37] sections.js 段定位自检（v0.2.10）
 *
 * P1 把结构改成嵌套 multipart（mixed → alternative → related），客户端会开始发
 * BODY[1.2.1] 这种多级段号。段定位一旦错位，表现就是「正文空白」—— 所以必须逐条验证：
 *   BODY[] / BODY[TEXT] / BODY[HEADER] / BODY[HEADER.FIELDS]
 *   BODY[1] / BODY[1.MIME] / BODY[1.TEXT] / BODY[1.1] / BODY[1.2.1]
 *
 * 用法：node scripts/verify-sections.mjs
 */
import { buildRfc822 } from '../src/mime.js';
import { extractSection } from '../src/sections.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const HTML = '<p>富文本 正文</p><img src="{{domain}}/attachments/k-img">';
const TEXT = '纯文本正文';

const detail = {
  emailId: 202,
  sendEmail: 'a@example.com',
  name: 'A',
  toEmail: 'me@example.com',
  subject: '段定位自检',
  messageId: '<m202@example.com>',
  createTime: '2026-11-12 08:00:00',
  content: HTML,
  text: TEXT,
  attList: [
    { key: 'k-img', filename: 'logo.png', mimeType: 'image/png', size: 300, contentId: 'c1' },
    { key: 'k-pdf', filename: 'r.pdf', mimeType: 'application/pdf', size: 600 },
  ],
};

const raw = await buildRfc822('me@example.com', 'pw', detail);

console.log('▶ 顶层');
check('BODY[] = 整封', extractSection(raw, '') === raw);
check('BODY[HEADER] 以 From: 开头', extractSection(raw, 'HEADER').startsWith('From: '));
check('BODY[HEADER] 以空行结束', extractSection(raw, 'HEADER').endsWith('\r\n\r\n'));
check('BODY[TEXT] 以 --混层 boundary 开头', extractSection(raw, 'TEXT').startsWith('--=_cm_202_mix'));
check('多段邮件没有顶层 Content-Transfer-Encoding',
  !/^Content-Transfer-Encoding:/m.test(extractSection(raw, 'HEADER')));
check('HEADER.FIELDS (SUBJECT) 只回主题',
  /Subject: /.test(extractSection(raw, 'HEADER.FIELDS (SUBJECT)')) &&
  !/From: /.test(extractSection(raw, 'HEADER.FIELDS (SUBJECT)')));

console.log('▶ 第一层 mixed');
const p1 = extractSection(raw, '1');
const p2 = extractSection(raw, '2');
check('BODY[1] = alternative 段正文（不含 MIME 头）',
  !p1.startsWith('Content-') && p1.startsWith('--=_cm_202_alt'));
check('BODY[1] 含两个子段', (p1.match(/--=_cm_202_alt/g) || []).length >= 3, `出现 ${(p1.match(/--=_cm_202_alt/g) || []).length} 次`);
check('BODY[2] = PDF 段正文（base64，不含头）',
  !p2.startsWith('Content-') && /^[A-Za-z0-9+/=\r\n]+$/.test(p2.trim()));
check('BODY[2.MIME] 带 attachment 处置', /Content-Disposition: attachment/.test(extractSection(raw, '2.MIME')));
check('BODY[3] 越界返回空', extractSection(raw, '3') === '');
check('BODY[1.MIME] 只回 MIME 头', extractSection(raw, '1.MIME').startsWith('Content-Type: multipart/alternative') &&
  !extractSection(raw, '1.MIME').includes('_alt--'));

console.log('▶ 第二层 alternative / related');
const plainPart = extractSection(raw, '1.1');
const htmlPart = extractSection(raw, '1.2.1');
const imgPart = extractSection(raw, '1.2.2');
const plainDecoded = Buffer.from(plainPart.replace(/\r\n/g, ''), 'base64').toString('utf8');
check('BODY[1.1] = text/plain 正文（不含头，解码正确）',
  !plainPart.startsWith('Content-') && plainDecoded === TEXT, plainDecoded.slice(0, 40));
check('BODY[1.1.TEXT] 解出的仍是纯文本正文',
  Buffer.from(extractSection(raw, '1.1.TEXT').replace(/\r\n/g, ''), 'base64').toString('utf8') === TEXT);
const htmlDecoded = Buffer.from(htmlPart.replace(/\r\n/g, ''), 'base64').toString('utf8');
check('BODY[1.2.1] = text/html 正文（不含头，解码正确）',
  !htmlPart.startsWith('Content-') && htmlDecoded.includes('cid:att-k-img@cloud-mail'), htmlDecoded.slice(0, 60));
check('BODY[1.2.1] 的 MIME 头里是 text/html', /Content-Type: text\/html/.test(extractSection(raw, '1.2.1.MIME')));
check('BODY[1.2.2] = 内联图正文（不含头）', !imgPart.startsWith('Content-') && imgPart.length > 0);
check('BODY[1.2.2.MIME] 带 Content-ID', /Content-ID: <att-k-img@cloud-mail>/.test(extractSection(raw, '1.2.2.MIME')));
check('BODY[1.2.2.TEXT] 长度 = 声明的 base64 长度',
  extractSection(raw, '1.2.2.TEXT').replace(/\r\n/g, '').length === Math.ceil(300 / 3) * 4,
  `实际 ${extractSection(raw, '1.2.2.TEXT').replace(/\r\n/g, '').length}`);
check('BODY[1.2.3] 越界返回空', extractSection(raw, '1.2.3') === '');
check('BODY[1.2] = related 段正文（不含头）',
  !extractSection(raw, '1.2').startsWith('Content-') && extractSection(raw, '1.2').includes('--=_cm_202_rel'));
check('BODY[1.2.MIME] 含 type="text/html" 参数', /type="text\/html"/.test(extractSection(raw, '1.2.MIME')));
// [v0.2.13] 防回归总闸：任何数字段都绝不能以 Content- 开头。
// 一旦开头，客户端会把头里的 Content/text/html/BASE64 当 base64 数据解码 → 整体错位 → 整屏乱码。
check('所有数字段都不以 Content- 开头（否则 base64 整体错位）',
  ['1', '2', '1.1', '1.2', '1.2.1', '1.2.2'].every((s) => !extractSection(raw, s).startsWith('Content-')));

console.log('▶ 单段邮件（无 multipart）');
const single = await buildRfc822('me@example.com', 'pw', { ...detail, attList: [], text: '' });
check('单段 BODY[1] = 正文（不含顶层头）',
  !extractSection(single, '1').startsWith('Content-Type:') && extractSection(single, '1').length > 0);
check('单段 BODY[1.MIME] 回顶层 Content-*',
  /Content-Type: text\/html/.test(extractSection(single, '1.MIME')));
check('单段 BODY[1.TEXT] = BODY[1]', extractSection(single, '1.TEXT') === extractSection(single, '1'));

// ---- [v0.2.14] 反向用例：这四个缺陷都曾真实发生，必须钉死 ----
console.log('▶ 反向用例（大小写 / NOT / 未知 / 单段头字段）');
// 1) 大小写：库把 section 原样传给 adapter，客户端发小写是合法的。
//    曾经 `1.mime` 落到兜底分支回「段头+正文」，而段头里的字母全是合法 base64 → 整屏乱码。
for (const s of ['1.MIME', '1.mime', '1.Mime', '1.mImE']) {
  check(`BODY[${s}] 只回段头（大小写不敏感）`, extractSection(raw, s) === extractSection(raw, '1.MIME'),
    `长度 ${extractSection(raw, s).length} vs ${extractSection(raw, '1.MIME').length}`);
}
for (const s of ['1.TEXT', '1.text']) {
  check(`BODY[${s}] 只回正文`, extractSection(raw, s) === extractSection(raw, '1.TEXT'));
}
check('BODY[1.header.fields (content-type)] 小写也生效',
  extractSection(raw, '1.header.fields (content-type)') === extractSection(raw, '1.HEADER.FIELDS (CONTENT-TYPE)'));

// 2) HEADER.FIELDS.NOT：旧实现当白名单，语义正好相反
const notHeader = extractSection(raw, 'HEADER.FIELDS.NOT (SUBJECT)');
check('BODY[HEADER.FIELDS.NOT (SUBJECT)] 不含 Subject', !/^Subject:/im.test(notHeader));
check('BODY[HEADER.FIELDS.NOT (SUBJECT)] 仍含 From', /^From:/im.test(notHeader));
const notPart = extractSection(raw, '1.HEADER.FIELDS.NOT (CONTENT-TYPE)');
check('BODY[1.HEADER.FIELDS.NOT (CONTENT-TYPE)] 不含 Content-Type', !/^Content-Type:/im.test(notPart));

// 3) 未知 specifier 绝不回整段/整封（旧兜底 return rawPart 是乱码根源）
for (const s of ['BOGUS', 'BOGUS.SPEC', '1.NONSENSE', '2.NONSENSE']) {
  check(`BODY[${s}] 回空而不是整段`, extractSection(raw, s) === '', `实际 ${extractSection(raw, s).length} 字节`);
}

// 4) 单段邮件取段头字段：旧实现只处理 MIME/TEXT，HEADER.FIELDS 回空行
const singleCt = extractSection(single, '1.HEADER.FIELDS (CONTENT-TYPE)');
check('单段 BODY[1.HEADER.FIELDS (CONTENT-TYPE)] 能取到', /^Content-Type:/im.test(singleCt), JSON.stringify(singleCt.slice(0, 40)));
check('单段 BODY[1.HEADER.FIELDS (CONTENT-TYPE)] 以空行结束', singleCt.endsWith('\r\n\r\n'));

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
