// [S37] 把 cloud-mail 已解析的邮件组装成 RFC822 原文 + 供 IMAP 复用的元信息
//
// 历史教训（每一步都是真实故障）：
//   v0.2.1：BODYSTRUCTURE 与实际正文结构不一致 → 客户端按描述取段拿错内容 → 正文空白
//   v0.2.7：附件结构少了 md5 占位 → disposition 跑到 md5 位 → 客户端把 PDF 当正文（整屏乱码）
//   v0.2.9：附件一律 11 项 → .txt/.eml 附件字段数错位
//
// v0.2.10 起改成「一棵 part 树 + 两个渲染器」，从根上消灭漂移：
//   buildTree()        → 唯一的结构事实（嵌套 multipart 也在树里）
//   renderStructure()  → BODYSTRUCTURE（同步，纯结构）
//   renderRootBody()   → RFC822 原文（附件未加载时用等长占位，保证长度可精确预估）
// 两者是同一棵树的两种表现，字段数 / 段数 / 字节数不可能再对不上。
//
// 结构映射（按 RFC 3501 §7.4.2）：
//   html + text        → multipart/alternative( text/plain, text/html )
//   有内联图           → html 段包 multipart/related( text/html, image/* + Content-ID )
//   有普通附件         → 最外层 multipart/mixed( 正文, 附件... )
//   什么都没有         → 单段 text/plain

import { fetchAtt } from './worker-client.js';

const CRLF = '\r\n';

function toBuf(input) {
  if (Buffer.isBuffer(input)) return input;
  return Buffer.from(String(input ?? ''), 'utf8');
}

function b64(input) {
  return toBuf(input).toString('base64').replace(/(.{76})/g, '$1\r\n');
}

// b64() 每 76 字符插一个 CRLF，这里算出编码后的真实字节数 / 行数
// v0.2.9：空内容行数必须为 0（原来恒 +1，结构说 1 行而实际 0 字节）
function b64Metrics(byteLen) {
  const enc = Math.ceil(Math.max(0, Number(byteLen) || 0) / 3) * 4;
  const breaks = Math.floor(enc / 76);
  return { size: enc + breaks * 2, lines: enc === 0 ? 0 : breaks + 1 };
}

// [v0.2.9] 时间解析容错：createTime 可能为 ""、非法串、时间戳、或已是 ISO。
// 原来 new Date('Invalid') → Date 头输出 "Invalid Date"，客户端按坏日期排序/显示 1970。
export function safeDate(v, fallback = new Date()) {
  if (v === null || v === undefined || v === '') return fallback;
  if (v instanceof Date) return isNaN(v.getTime()) ? fallback : v;
  const raw = String(v).trim();
  if (!raw) return fallback;
  if (/^\d{10}$/.test(raw)) return new Date(Number(raw) * 1000);          // 秒级时间戳
  if (/^\d{13}$/.test(raw)) return new Date(Number(raw));                  // 毫秒时间戳
  const iso = /[T ]/.test(raw)
    ? raw.replace(' ', 'T') + (/[Zz]|[+-]\d{2}:?\d{2}$/.test(raw) ? '' : 'Z') // 无时区按 UTC
    : raw;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? fallback : d;
}

// RFC 2047：非 ASCII 头编码
// [v0.2.14] 导出给 adapters.js 用：ENVELOPE 的 subject / 显示名同样是 7bit 头字段，
// 库的 buildEnvelope 直接原样塞进双引号（不做编码）→ 中文主题在客户端按 ASCII 解析必乱码。
export function encodeHeader(text) {
  const str = String(text ?? '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

// [v0.2.17] 已发送邮件在站内只写 recipient（JSON 数组），to_email / to_name 恒为空：
// 官方 saveSentEmail() 从头到尾不给这两列赋值。结果 ENVELOPE To 和 To 头全是空的，
// 客户端拉下来就是一封「没有收件人」的已发送邮件（实测 22 封全空）。
// 这里从 recipient 还原地址列表，只在 to_email 为空时兜底，收件箱等正常邮件零影响。
export function parseRecipientList(jsonStr) {
  try {
    const arr = JSON.parse(jsonStr || '[]');
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(a => a && a.address)
      .map(a => ({ address: String(a.address), name: a.name ? String(a.name) : '' }));
  } catch (e) {
    return [];
  }
}

// To 头取值：to_email 有值就用它（官方路径），否则按 recipient 还原（多收件人用逗号连接）
export function toHeaderValue(detail) {
  if (!detail) return '';
  const direct = String(detail.toEmail || '').trim();
  if (direct) return direct;
  return parseRecipientList(detail.recipient)
    .map(a => (a.name ? `${encodeHeader(a.name)} <${a.address}>` : a.address))
    .join(', ');
}

function foldHeader(name, value) {
  return `${name}: ${String(value ?? '').replace(/\r?\n/g, ' ')}`;
}

// 参数值（带引号，非 ASCII 用 RFC2047）
function paramValue(text) {
  const str = String(text ?? '');
  const safe = /^[\x20-\x7E]*$/.test(str)
    ? str
    : `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
  return `"${safe.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const q = paramValue;

function parseAddrList(jsonStr) {
  try {
    const arr = JSON.parse(jsonStr || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.filter(a => a && a.address).map(a => a.address);
  } catch (e) {
    return [];
  }
}

function addrLine(addrs) {
  return addrs.join(', ');
}

// 头部（不含 Content-Type，由 part 树决定）
function baseHeaders(detail) {
  const dateStr = safeDate(detail.createTime, new Date()).toUTCString();
  const from = detail.sendEmail || '';
  const fromName = detail.name || '';
  const headers = [];
  headers.push(foldHeader('From', fromName ? `${encodeHeader(fromName)} <${from}>` : from));
  headers.push(foldHeader('To', toHeaderValue(detail)));
  const ccList = parseAddrList(detail.cc);
  if (ccList.length) headers.push(foldHeader('Cc', addrLine(ccList)));
  headers.push(foldHeader('Subject', encodeHeader(detail.subject || '')));
  headers.push(foldHeader('Date', dateStr));
  headers.push(foldHeader('Message-ID', detail.messageId || `<cm-${detail.emailId}@cloud-mail>`));
  if (detail.inReplyTo) headers.push(foldHeader('In-Reply-To', detail.inReplyTo));
  headers.push('MIME-Version: 1.0');
  return headers;
}

// ---------- part 树 ----------

// 附件真实字节数：优先采信已下载记录，其次主程序记录的 size
function attBytesOf(detail, att) {
  const actual = detail._attSizes && att.key !== undefined ? detail._attSizes[att.key] : undefined;
  if (actual !== undefined && actual !== null && Number.isFinite(Number(actual))) return Number(actual);
  return Math.max(0, Number(att.size) || 0);
}

// [v0.2.10] 内联资源判定：只认 contentId / disposition=inline，
// 不猜 type 数字语义（主程序换了枚举就会把普通附件塞进 related，附件直接消失）
function isInlineAtt(att) {
  if (!att) return false;
  if (att.contentId || att.contentID || att['content-id']) return true;
  return /^inline$/i.test(String(att.disposition || ''));
}

function leafOfText(text, mime, extra = {}) {
  return {
    kind: 'leaf',
    mime,
    params: { CHARSET: 'UTF-8' },
    encoding: 'base64',
    text: String(text ?? ''),
    bytes: Buffer.byteLength(String(text ?? ''), 'utf8'),
    ...extra,
  };
}

function leafOfAtt(detail, att, extra = {}) {
  const fname = att.filename || 'attachment';
  const mime = String(att.mimeType || 'application/octet-stream');
  const isText = /^text\//i.test(mime);
  const bytes = attBytesOf(detail, att);
  return {
    kind: 'leaf',
    mime,
    params: isText ? { CHARSET: 'UTF-8', NAME: fname } : { NAME: fname },
    encoding: 'base64',
    bytes,
    filename: fname,
    disposition: extra.disposition || 'attachment',
    contentId: extra.contentId,
    att,
  };
}

// [v0.2.10] 把主程序改写过的 cid 引用（{{domain}}/attachments/<key> 或真实域名 URL）换回 cid:
// 不换的话内联图仍指向远程地址：客户端默认拦截远程图片 → 正文里全是空白占位框。
function rewriteCid(html, cidMap) {
  let out = String(html ?? '');
  for (const { key, cid } of cidMap) {
    if (!key) continue;
    const esc = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:https?:)?(?:\\/\\/)?[^"'\\s()<>]*\\/attachments\\/${esc}[^"'\\s()<>]*`, 'g');
    out = out.replace(re, `cid:${cid}`);
  }
  return out;
}

function multi(subtype, children, boundary, params = {}) {
  return { kind: 'multi', subtype: subtype.toUpperCase(), mime: `multipart/${subtype}`, boundary, params, children };
}

export function buildTree(detail) {
  const emailId = detail.emailId || 0;
  const htmlRaw = detail.content || '';
  const textRaw = detail.text || '';
  const atts = Array.isArray(detail.attList) ? detail.attList : [];

  const inlineAtts = atts.filter(isInlineAtt);
  const fileAtts = atts.filter(a => !isInlineAtt(a));

  // 内联资源：Content-ID 用附件 key（客户端按 cid 匹配，必须与 html 里的引用一致）
  const cidMap = [];
  const relatedKids = [];
  inlineAtts.forEach((att, i) => {
    const cid = `att-${att.key || i}@cloud-mail`;
    cidMap.push({ key: att.key, cid });
    relatedKids.push(leafOfAtt(detail, att, { disposition: 'inline', contentId: cid }));
  });

  const html = cidMap.length ? rewriteCid(htmlRaw, cidMap) : htmlRaw;

  // 正文部分
  let bodyPart;
  if (html) {
    const htmlLeaf = leafOfText(html, 'text/html');
    if (relatedKids.length) {
      bodyPart = multi('related', [htmlLeaf, ...relatedKids], `=_cm_${emailId}_rel`, { TYPE: 'text/html' });
    } else {
      bodyPart = htmlLeaf;
    }
    if (textRaw) {
      // text 与 html 同时存在 → alternative（纯文本客户端回退到第一段，不再显示空白）
      bodyPart = multi('alternative', [leafOfText(textRaw, 'text/plain'), bodyPart], `=_cm_${emailId}_alt`);
    }
  } else if (textRaw) {
    bodyPart = leafOfText(textRaw, 'text/plain');
  } else {
    bodyPart = leafOfText('', 'text/plain');
  }

  if (!fileAtts.length) return bodyPart;

  const attParts = fileAtts.map(att => leafOfAtt(detail, att));
  return multi('mixed', [bodyPart, ...attParts], `=_cm_${emailId}_mix`);
}

// ---------- 渲染 BODYSTRUCTURE ----------

// 参数组：("CHARSET" "UTF-8" "NAME" "a.png")
function paramGroup(params) {
  const entries = Object.entries(params || {});
  if (!entries.length) return 'NIL';
  return `(${entries.map(([k, v]) => `${q(k)} ${paramValue(v)}`).join(' ')})`;
}

// RFC 3501 §7.4.2 三种 body 模板必须严格区分字段数，多一个少一个客户端就整体错位：
//   text/*          8 项 = type subtype params id desc enc octets lines
//   message/rfc822 10 项 = 同上前 7 项 + envelope + body + lines
//   其它（含 application）11 项 = 前 7 项 + md5 disp lang loc
function structOfLeaf(node) {
  const mime = String(node.mime || 'application/octet-stream').toLowerCase();
  const slash = mime.indexOf('/');
  const type = (slash > 0 ? mime.slice(0, slash) : mime) || 'application';
  const subtype = slash > 0 ? mime.slice(slash + 1) : 'octet-stream';
  const T = q(type.toUpperCase());
  const S = q(subtype.toUpperCase());
  const metrics = b64Metrics(node.bytes);
  const params = paramGroup(node.params);
  const dspName = node.filename ? `; filename=${paramValue(node.filename)}` : '';
  const dsp = node.disposition
    ? `(${q(String(node.disposition).toUpperCase())}${node.filename ? ` ("FILENAME" ${paramValue(node.filename)})` : ' NIL'})`
    : 'NIL';

  if (type === 'text') {
    // 正文行数用解码后的真实行数；附件没加载过就用 base64 行数近似（客户端不读附件的 lines）
    const lines = node.text !== undefined
      ? (node.text === '' ? 0 : String(node.text).split(/\r\n|\r|\n/).length)
      : metrics.lines;
    return `(${T} ${S} ${params} NIL NIL "BASE64" ${metrics.size} ${lines})`;
  }
  if (type === 'message') {
    // ENVELOPE 10 个字段全 NIL 是合法值：客户端读不到内嵌信摘要，但结构绝对安全
    return `(${T} ${S} ${params} NIL NIL "BASE64" ${metrics.size} ` +
      `(NIL NIL NIL NIL NIL NIL NIL NIL NIL NIL) ` +
      `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 0 0) ${metrics.lines})`;
  }
  return `(${T} ${S} ${params} NIL NIL "BASE64" ${metrics.size} NIL ${dsp} NIL NIL)`;
}

export function renderStructure(node) {
  if (node.kind === 'leaf') return structOfLeaf(node);
  return `(${node.children.map(renderStructure).join('')}` +
    `${q(node.subtype)} ${paramGroup({ BOUNDARY: node.boundary, ...node.params })} NIL NIL)`;
}

// ---------- 渲染 RFC822 ----------

function contentParams(node) {
  const entries = Object.entries(node.params || {});
  let out = '';
  if (node.boundary) out += `; boundary=${paramValue(node.boundary)}`;
  for (const [k, v] of entries) out += `; ${k.toLowerCase()}=${paramValue(v)}`;
  return out;
}

// [v0.2.10] 占位内容必须与真实 base64 **完全同构**（每 76 字符折行）：
// 只按总字节数 repeat('Q') 虽然长度一样，但行结构与真实内容不同，
// 客户端解码后拿到的是 410 个 Q 解出的 307 字节垃圾，而不是声明的 300 字节。
function placeholderBase64(bytes) {
  const enc = Math.ceil(Math.max(0, Number(bytes) || 0) / 3) * 4;
  return 'Q'.repeat(enc).replace(/(.{76})/g, '$1\r\n');
}

function leafBody(node, real) {
  if (node.text !== undefined) return b64(node.text);
  if (real && node.loaded) return b64(node.loaded);
  // 未加载/加载失败：用与声明字节等长的占位。绝不能填空 ——
  // BODYSTRUCTURE 报 N 字节而实际发 0 字节时，客户端按字节偏移取后续段会全部错位。
  return placeholderBase64(node.bytes);
}

// [v0.2.10] 根节点与嵌套段要分开渲染：
//   根   → Content-Type 已由顶层头写掉，这里只出 body（否则根段头会重复一次，
//          客户端读到的 BODY[TEXT] 头两行是 Content-Type，正文整体错位）
//   嵌套 → 每段必须自带 Content-Type（含 boundary）
function renderLeafPart(node, real) {
  const h = [];
  h.push(`Content-Type: ${node.mime}${contentParams(node)}`);
  h.push(`Content-Transfer-Encoding: ${node.encoding}`);
  if (node.contentId) h.push(`Content-ID: <${node.contentId}>`);
  if (node.disposition) {
    h.push(`Content-Disposition: ${node.disposition}${node.filename ? `; filename=${paramValue(node.filename)}` : ''}`);
  }
  h.push('');
  h.push(leafBody(node, real));
  return h.join(CRLF);
}

function renderMultipart(node, real) {
  const out = [];
  for (const child of node.children) {
    out.push(`--${node.boundary}`);
    out.push(renderPart(child, real));
  }
  out.push(`--${node.boundary}--`);
  out.push('');
  return out.join(CRLF);
}

function renderPart(node, real) {
  if (node.kind === 'leaf') return renderLeafPart(node, real);
  return `Content-Type: ${node.mime}${contentParams(node)}${CRLF}${CRLF}` + renderMultipart(node, real);
}

function renderRootBody(node, real) {
  return node.kind === 'leaf' ? leafBody(node, real) : renderMultipart(node, real);
}

function rootWithHeaders(detail, tree) {
  const headers = baseHeaders(detail);
  headers.push(`Content-Type: ${tree.mime}${contentParams(tree)}`);
  if (tree.kind === 'leaf') headers.push(`Content-Transfer-Encoding: ${tree.encoding}`);
  return headers.join(CRLF) + CRLF + CRLF;
}

// ---------- 对外：精确元信息（sizeBytes + bodyStructure） ----------

export function computeMeta(detail) {
  if (!detail) return { sizeBytes: 0, bodyStructure: '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" 0 0)' };
  const tree = buildTree(detail);
  const raw = rootWithHeaders(detail, tree) + renderRootBody(tree, false);
  return {
    sizeBytes: Buffer.byteLength(raw, 'utf8'),
    bodyStructure: renderStructure(tree),
  };
}

// 预载全部附件（含内联图）：一次并发下载，失败也不抛（渲染时用等长占位兜底）
async function loadAttachments(tree, email, appPassword, detail) {
  const leaves = [];
  (function walk(n) {
    if (!n) return;
    if (n.kind === 'leaf') {
      if (n.att) leaves.push(n);
      return;
    }
    for (const c of n.children) walk(c);
  })(tree);

  await Promise.all(leaves.map(async (node) => {
    if (!node.att || node.att.key === undefined || node.att.key === null) return;
    try {
      const buf = await fetchAtt(email, appPassword, node.att.key);
      if (buf) {
        node.loaded = buf;
        // 只记录事实，**不改 node.bytes**：bytes 已在 BODYSTRUCTURE 里发出去，
        // 这里改掉会让本次原文长度与已声明的 RFC822.SIZE 不一致。下次 computeMeta 自然采信。
        detail._attSizes = detail._attSizes || {};
        detail._attSizes[node.att.key] = buf.length;
      }
    } catch (e) {
      node.loaded = null;
    }
  }));
}

// ---------- 对外：RFC822 原文 ----------

export async function buildRfc822(email, appPassword, detail) {
  if (!detail) return '';
  const tree = buildTree(detail);
  await loadAttachments(tree, email, appPassword, detail);
  return rootWithHeaders(detail, tree) + renderRootBody(tree, true);
}
