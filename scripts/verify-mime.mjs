/**
 * [S37] mime.js 结构自检（v0.2.9）
 *
 * 验证 BODYSTRUCTURE 与 RFC822 原文严格自洽 —— 这是「客户端正文空白 / 附件乱码」的唯一防线：
 *   1) 无附件：sizeBytes === 原文真实字节数，结构 = 8 项 text
 *   2) 有附件：sizeBytes === 原文真实字节数，附件按 MIME 类型走 8 / 10 / 11 项模板
 *   3) 空正文：size 0，lines 0
 *   4) 非法 createTime：Date 头不是 "Invalid Date"
 *
 * 附件下载在测试环境必然失败（WORKER_BASE 为空 → 相对 URL 抛错），
 * 正好用来验证「取不到附件时用等长占位」这条保命逻辑是否成立。
 *
 * 用法：node scripts/verify-mime.mjs
 */
import { computeMeta, buildRfc822 } from '../src/mime.js';

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// 数出一个 BODYSTRUCTURE 括号组的顶层字段个数（跳过嵌套括号与引号字符串）
function countFields(struct) {
  const s = struct.trim();
  if (!s.startsWith('(') || !s.endsWith(')')) return -1;
  const inner = s.slice(1, -1);
  let depth = 0;
  let inStr = false;
  let fields = 0;
  let has = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; has = true; continue; }
    if (ch === '(') { depth++; has = true; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth === 0 && ch === ' ') {
      if (has) { fields++; has = false; }
      continue;
    }
    has = true;
  }
  if (has) fields++;
  return fields;
}

// 取 multipart 结构里子段的字段数
function childStructs(struct) {
  const inner = struct.trim().slice(1, -1);
  const out = [];
  let depth = 0;
  let inStr = false;
  let start = -1;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '(') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && start !== -1) {
        out.push(inner.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

const base = {
  emailId: 101,
  sendEmail: 'sender@example.com',
  name: '发件人',
  toEmail: 'me@example.com',
  subject: '结构自检',
  messageId: '<m101@example.com>',
  createTime: '2026-11-12 06:30:00',
};

const cases = [
  {
    name: '纯文本、无附件',
    detail: { ...base, text: 'Hello 你好', content: '', attList: [] },
    expectParts: 0,
    expectFirst: 8,
  },
  {
    name: '仅 HTML、无附件',
    detail: { ...base, text: '', content: '<p>Hello</p>', attList: [] },
    expectParts: 0,
    expectFirst: 8,
  },
  {
    name: 'HTML + PDF 附件（11 项模板）',
    detail: {
      ...base,
      content: '<p>正文</p>',
      attList: [{ key: 'k-pdf', filename: '报告.pdf', mimeType: 'application/pdf', size: 4096 }],
    },
    expectParts: 1,
    expectFirst: 8,
    expectAtt: [11],
  },
  {
    name: 'HTML + TXT 附件（text/* 必须 8 项）',
    detail: {
      ...base,
      content: '<p>正文</p>',
      attList: [{ key: 'k-txt', filename: '说明.txt', mimeType: 'text/plain', size: 1024 }],
    },
    expectParts: 1,
    expectFirst: 8,
    expectAtt: [8],
  },
  {
    name: 'HTML + EML 附件（message/rfc822 必须 10 项）',
    detail: {
      ...base,
      content: '<p>正文</p>',
      attList: [{ key: 'k-eml', filename: '原始.eml', mimeType: 'message/rfc822', size: 2048 }],
    },
    expectParts: 1,
    expectFirst: 8,
    expectAtt: [10],
  },
  {
    name: 'HTML + TXT + PDF 混合附件',
    detail: {
      ...base,
      content: '<p>正文</p>',
      attList: [
        { key: 'k1', filename: 'a.txt', mimeType: 'text/plain', size: 300 },
        { key: 'k2', filename: 'b.pdf', mimeType: 'application/pdf', size: 900 },
      ],
    },
    expectParts: 2,
    expectFirst: 8,
    expectAtt: [8, 11],
  },
  {
    name: '空正文、无附件',
    detail: { ...base, text: '', content: '', attList: [] },
    expectParts: 0,
    expectFirst: 8,
    expectEmpty: true,
  },
  {
    name: '非法 createTime',
    detail: { ...base, createTime: 'not-a-date', text: 'x', content: '', attList: [] },
    expectParts: 0,
    expectFirst: 8,
  },
  {
    name: 'createTime 为 ISO 带时区',
    detail: { ...base, createTime: '2026-11-12T06:30:00.000+08:00', text: 'x', content: '', attList: [] },
    expectParts: 0,
    expectFirst: 8,
  },
  {
    name: 'HTML + 纯文本（必须 multipart/alternative）',
    detail: { ...base, content: '<p>富文本</p>', text: '纯文本', attList: [] },
    contains: ['"ALTERNATIVE"', '"TEXT" "PLAIN"', '"TEXT" "HTML"'],
    topKids: 2,
  },
  {
    name: 'HTML + 内联图（必须 multipart/related + Content-ID）',
    detail: {
      ...base,
      content: '<p><img src="{{domain}}/attachments/k-img"></p>',
      attList: [{ key: 'k-img', filename: 'logo.png', mimeType: 'image/png', size: 512, contentId: 'orig@x' }],
    },
    contains: ['"RELATED"', '"TYPE" "text/html"', '"IMAGE" "PNG"'],
    topKids: 2,
    rawContains: ['Content-ID: <att-k-img@cloud-mail>', 'Content-Disposition: inline'],
  },
  {
    name: 'HTML + 纯文本 + 内联图 + PDF（三层嵌套）',
    detail: {
      ...base,
      content: '<p><img src="https://mail.example.com/attachments/k-img?x=1"></p>',
      text: '纯文本',
      attList: [
        { key: 'k-img', filename: 'logo.png', mimeType: 'image/png', size: 512, contentId: 'c1' },
        { key: 'k-pdf', filename: 'r.pdf', mimeType: 'application/pdf', size: 4096 },
      ],
    },
    contains: ['"MIXED"', '"ALTERNATIVE"', '"RELATED"', '"APPLICATION" "PDF"'],
    topKids: 2,
  },
];

for (const c of cases) {
  console.log(`\n▶ ${c.name}`);
  const meta = computeMeta(c.detail);
  const raw = await buildRfc822('me@example.com', 'pw', c.detail);
  const rawBytes = Buffer.byteLength(raw, 'utf8');

  check('sizeBytes === 原文真实字节数', meta.sizeBytes === rawBytes, `报 ${meta.sizeBytes} 实际 ${rawBytes}`);
  check('Date 头合法', !/Invalid Date/.test(raw), raw.split('\r\n')[0]);

  const attStarts = (meta.bodyStructure.match(/^\(| \(\(/g) || []).length;
  if (c.contains) {
    for (const kw of c.contains) check(`结构含 ${kw}`, meta.bodyStructure.includes(kw));
  }
  if (c.topKids !== undefined) {
    const kids = childStructs(meta.bodyStructure).filter(k => !/^\("BOUNDARY"/i.test(k));
    check(`顶层段数 = ${c.topKids}`, kids.length === c.topKids, `实际 ${kids.length}`);
  }
  if (c.rawContains) {
    for (const kw of c.rawContains) check(`原文含 ${kw}`, raw.includes(kw), '未找到');
  }
  if (c.expectParts === 0) {
    check('单段结构字段数 = 8', countFields(meta.bodyStructure) === 8, `实际 ${countFields(meta.bodyStructure)}`);
  } else if (c.expectParts) {
    const kids = childStructs(meta.bodyStructure);
    // 顶层括号组 = 正文段 + 各附件段 + 末尾的 ("BOUNDARY" "...") 参数组
    const bodyKids = kids.filter(k => !/^\("BOUNDARY"/i.test(k));
    check(`子段数 = ${c.expectParts + 1}（正文 + ${c.expectParts} 附件）`, bodyKids.length === c.expectParts + 1, `实际 ${bodyKids.length}`);
    check('正文段字段数 = 8', countFields(bodyKids[0]) === 8, `实际 ${countFields(bodyKids[0])}`);
    for (let i = 0; i < (c.expectAtt || []).length; i++) {
      const got = countFields(bodyKids[i + 1]);
      check(`附件 ${i + 1} 字段数 = ${c.expectAtt[i]}`, got === c.expectAtt[i], `实际 ${got}`);
    }
  }

  if (c.expectEmpty) {
    const m = meta.bodyStructure.match(/"BASE64" 0 (\d+)\)/);
    check('空正文 lines = 0', !!m && m[1] === '0', m ? `lines=${m[1]}` : '未匹配');
  }

  // base64 正文必须能解码（客户端解码失败 = 正文空白）
  const bodyPart = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  if (bodyPart && !/boundary=|multipart/.test(raw.split('\r\n\r\n')[0])) {
    const cleaned = bodyPart.replace(/\r\n/g, '');
    const decoded = Buffer.from(cleaned, 'base64').toString('utf8');
    check('单段正文 base64 可解码', decoded.length > 0 || c.expectEmpty, `解码得 ${decoded.length} 字符`);
  }
  void attStarts;
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
