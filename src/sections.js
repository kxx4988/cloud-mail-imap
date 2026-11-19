// [S37] IMAP section 提取（v0.2.1 新增）
//
// 库（@rafters/mail-imap 0.1.0）对段号一律返回整封原文，客户端按 BODYSTRUCTURE 取段时必然错。
// 这里按 RFC 3501 从我们生成的 RFC822 原文里精确切出：
//   BODY[]           整封
//   BODY[TEXT]       正文（头之后）
//   BODY[HEADER]     头
//   BODY[HEADER.FIELDS (A B)]  只回指定头
//   BODY[n]          第 n 段的正文（v0.2.13 起剥掉该段 MIME 头，之前带头 → 客户端解码整体错位 → 乱码）
//   BODY[n.MIME]     第 n 段的 MIME 头
//   BODY[n.TEXT]     第 n 段的正文
//   BODY[n.HEADER.FIELDS (...)] 第 n 段的指定头

const CRLF = '\r\n';

// [v0.2.10] 头必须含结尾的空行（CRLF CRLF）：原来 slice(0, i+2) 会切在 \r 与 \n 之间，
// 客户端拿到的头最后一行缺 \n，部分解析器会把它和正文首行粘在一起。
function splitRaw(raw) {
  const s = String(raw ?? '');
  const i = s.indexOf(CRLF + CRLF);
  if (i === -1) return { header: s, body: '' };
  return { header: s.slice(0, i + 4), body: s.slice(i + 4) };
}

// 头展开成 [{name, value}]（处理折行）
function headerList(header) {
  const lines = String(header).split(CRLF);
  const unfolded = [];
  for (const line of lines) {
    if (!line) continue;
    if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length) {
      unfolded[unfolded.length - 1] += ' ' + line.trim();
    } else {
      unfolded.push(line);
    }
  }
  const out = [];
  for (const line of unfolded) {
    const i = line.indexOf(':');
    if (i > 0) out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  }
  return out;
}

function boundaryOf(header) {
  const ct = headerList(header).find(h => h.name.toLowerCase() === 'content-type');
  if (!ct) return '';
  const m = ct.value.match(/boundary\s*=\s*(?:"([^"]*)"|([^;\s]+))/i);
  if (!m) return '';
  return m[1] !== undefined ? m[1] : m[2];
}

function isMultipart(header) {
  const ct = headerList(header).find(h => h.name.toLowerCase() === 'content-type');
  return !!ct && /^multipart\//i.test(ct.value);
}

// 按 boundary 切分（返回每段原文：段头 + 空行 + 段体）
function splitParts(body, boundary) {
  const delim = `--${boundary}`;
  const chunks = String(body).split(delim);
  const out = [];
  for (let i = 1; i < chunks.length; i++) {
    let c = chunks[i];
    if (c.startsWith('--')) break; // 结束边界
    if (c.startsWith(CRLF)) c = c.slice(2);
    if (c.endsWith(CRLF)) c = c.slice(0, -2);
    out.push(c);
  }
  return out;
}

// [v0.2.14] negate=true 时是 HEADER.FIELDS.NOT 语义（排除列出的字段，其余全留）。
// 旧实现没有 negate，NOT 被当白名单 → 语义正好相反（客户端要「除 Subject 外的头」却只拿到 Subject）。
function filterHeaderFields(header, spec, negate = false) {
  const m = String(spec).match(/\(([^)]*)\)/);
  if (!m) return header; // 没有字段列表：保守回全部，不做静默错误过滤
  const wanted = m[1].split(/\s+/).filter(Boolean).map(s => s.toLowerCase());
  const lines = String(header).split(CRLF);
  const kept = [];
  let keep = false;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (keep) kept.push(line);
      continue;
    }
    const i = line.indexOf(':');
    const name = i > 0 ? line.slice(0, i).trim().toLowerCase() : '';
    keep = name ? (negate ? !wanted.includes(name) : wanted.includes(name)) : false;
    if (keep) kept.push(line);
  }
  // 响应必须以空行收尾（RFC 3501 §7.4.2），客户端按此判断头结束
  return (kept.length ? kept.join(CRLF) + CRLF : '') + CRLF;
}

// [S37] 单段邮件的「第 1 段」就是整封正文，它没有独立的 MIME 头：
// Content-Type / Content-Transfer-Encoding 全写在顶层头里（dovecot 同样这么回）。
// 旧实现在单段分支把正文当 MIME 头返回，客户端拿不到编码信息 → 正文白屏。
function contentHeaders(header) {
  const lines = String(header).split(CRLF);
  const kept = [];
  let keep = false;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (keep) kept.push(line);
      continue;
    }
    const i = line.indexOf(':');
    const name = i > 0 ? line.slice(0, i).trim().toLowerCase() : '';
    keep = name.startsWith('content-') || name === 'mime-version';
    if (keep) kept.push(line);
  }
  return kept.length ? kept.join(CRLF) + CRLF + CRLF : CRLF;
}

// [v0.2.13] 取「某一层的正文」：剥掉这一层自己的 MIME 头。
// 不能直接复用 splitRaw：没有段头时 splitRaw 会回 {body:''} 把内容丢掉。
function partBody(rawPart) {
  const s = String(rawPart ?? '');
  const i = s.indexOf(CRLF + CRLF);
  if (i === -1) return s; // 没有段头 → 整段就是正文
  return s.slice(i + 4);
}

function applySpec(rawPart, spec, isRoot) {
  // spec 一律由 extractSection 转大写后传入
  if (spec === '') {
    // [v0.2.13] **乱码最终根因**：BODY[n] 是「该段正文」，不含该段自己的 MIME 头；
    // BODY[n.MIME] 才是头（RFC 3501 §6.4.5）。
    // 旧实现 BODY[n] 回「头 + 空行 + 正文」，而 part 头里的 Content-Type / text / html /
    // charset / BASE64 全是**合法 base64 字母**，客户端拿这段直接 base64 解码 →
    // 从第一个字节起整体错位 → 正文整屏乱码（不是空白，是乱码）。
    return isRoot ? rawPart : partBody(rawPart);
  }

  const { header, body } = splitRaw(rawPart);

  if (spec === 'MIME' || spec === 'HEADER') return header;
  if (spec === 'TEXT') return body;
  // NOT 必须先判：HEADER.FIELDS.NOT 也以 'HEADER.FIELDS' 开头，先判后者会把 NOT 当白名单
  if (spec.startsWith('HEADER.FIELDS.NOT')) return filterHeaderFields(header, spec, true);
  if (spec.startsWith('HEADER.FIELDS')) return filterHeaderFields(header, spec, false);

  // [v0.2.14] 未知 specifier **绝不**兜底回整段/整封。
  // 旧实现 `return rawPart` 是这次乱码能发生的根源：一旦 spec 因大小写或拼写没命中，
  // 客户端就拿到「头 + 正文」，头里的 Content-Type/text/html/BASE64 全是合法 base64 字母，
  // 解码从第一个字节起整体错位。宁可回空并记日志，也不能回一段会被误当正文解码的数据。
  console.warn(`[imap] unsupported section spec: ${spec}`);
  return '';
}

/**
 * 从整封 RFC822 原文里取出 section 指定的内容。
 * @param {string} raw 完整邮件原文
 * @param {string} section IMAP 的 BODY[...] 中括号里的内容（可为空串）
 * @returns {string}
 */
export function extractSection(raw, section) {
  const src = String(raw ?? '');
  const specRaw = String(section ?? '').trim();

  // 拆出数字路径 + 末尾 specifier
  let rest = specRaw;
  const nums = [];
  while (/^\d+/.test(rest)) {
    const m = rest.match(/^(\d+)/);
    nums.push(Number(m[1]));
    rest = rest.slice(m[1].length);
    if (rest.startsWith('.')) rest = rest.slice(1);
  }
  // [v0.2.14] **必须在这里统一大写**：库把 section 原样传给 adapter（它自己的 fallback
  // 才会 toUpperCase），旧实现只在「无数字路径」时转，导致 BODY[1.mime] / [1.text] /
  // [1.header.fields (...)] 全部落到 applySpec 的兜底分支 → 回「段头+正文」→ 同一个乱码复发。
  const spec = rest.trim().toUpperCase();

  if (!nums.length) {
    if (!spec) return src; // BODY[] / BODY[]<x.y>
    // [v0.2.14] 旧实现这里 `return src` 兜底，未知 spec 直接回整封 —— 同 applySpec 的危险兜底
    return applySpec(src, spec, true);
  }

  let node = src;
  let singlePart = false;
  for (const n of nums) {
    const { header, body } = splitRaw(node);
    const boundary = boundaryOf(header);
    if (!boundary) {
      if (n === 1) {
        // 单段邮件只有 part 1：BODY[1] == BODY[TEXT]（正文，不带顶层头）
        singlePart = true;
        node = body;
        continue;
      }
      return '';
    }
    const parts = splitParts(body, boundary);
    const picked = parts[n - 1];
    if (picked === undefined) return '';
    node = picked;
  }

  if (singlePart) {
    // 单段邮件的「第 1 段」没有自己的 MIME 头，Content-* 全在顶层头里（dovecot 同此行为）。
    // [v0.2.14] 旧实现只处理 MIME/TEXT，BODY[1.HEADER.FIELDS (CONTENT-TYPE)] 回空行；
    // 现在伪造一个「Content-* 头 + 正文」的 part 交给 applySpec，四种 specifier 结果一致。
    if (spec === '' || spec === 'TEXT') return node;
    const pseudo = contentHeaders(splitRaw(src).header) + node;
    return applySpec(pseudo, spec, false);
  }

  return applySpec(node, spec, false);
}
