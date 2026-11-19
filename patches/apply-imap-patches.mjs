/**
 * [S37] @rafters/mail-imap 运行时补丁（Dockerfile 构建时执行，幂等）
 *
 * 该库 0.1.0 有几处会让真实客户端（Apple Mail / Outlook / Foxmail）"列表能看、点开正文空白"的缺陷：
 *  1) FETCH BODYSTRUCTURE 恒报 `("TEXT" "PLAIN" ... "8BIT" <estimate> 1)`——
 *     不管真实邮件是单段还是 multipart、正文多大，客户端按这个描述去取段必然拿到不符内容。
 *     改为优先使用适配器算好的精确结构（message.bodyStructure）。
 *  2) fetchBodySection 对 BODY[TEXT] / BODY[HEADER.FIELDS] 一律返回整封（含头）；段号 BODY[1] 也回整封。
 *     改为优先委派 adapter.getSection()（我们在 src/sections.js 里按 RFC 精确切分）。
 *  3) 兜底路径（适配器未提供 getSection 时）仍按 header/body 粗略切分。
 *  4) UID FETCH 响应不带 UID（RFC 3501 §6.4.8 要求必须带）——
 *     Apple Mail 拿不到 UID 就无法把正文关联到邮件，界面永远「正在载入…」。
 *  5) 不支持 RFC822 / RFC822.HEADER / RFC822.TEXT 三个标准宏（直接回 BAD），
 *     映射到 BODY[] / BODY[HEADER] / BODY[TEXT]。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, '..', 'node_modules', '@rafters', 'mail-imap', 'dist');
// [v0.2.15] server 包与库分离发布，literal / NOOP / IDLE 三处都改在 server 侧
const serverDist = path.join(here, '..', 'node_modules', '@rafters', 'mail-imap-server', 'dist');
// ID 命令回给客户端的版本号跟 package.json 走，避免每次升版都要改补丁
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
const target = path.join(distDir, 'chunk-NEG3QHYJ.js');
const parseTarget = path.join(distDir, 'chunk-EYMWACFL.js');

if (!fs.existsSync(target)) {
  console.error(`[patch] 未找到 ${target}，跳过（库版本可能已变，需人工复核）`);
  process.exit(0);
}

let src = fs.readFileSync(target, 'utf8');
const before = src;
let applied = 0;

/* ---- 1) BODYSTRUCTURE / BODY：使用适配器提供的精确结构 ---- */
const structRe = /case "(BODYSTRUCTURE|BODY)":\s*\r?\n\s*data\.bodyStructure = [^\n]+;/g;
let matchedStruct = 0;
src = src.replace(structRe, (full, keyword) => {
  matchedStruct++;
  return `case "${keyword}":\n          data.bodyStructure = message.bodyStructure ?? '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" 1 1)';`;
});
if (matchedStruct > 0) {
  if (src.includes('message.bodyStructure ??')) applied++;
} else {
  console.warn('[patch] BODYSTRUCTURE 片段未匹配，需人工检查');
}

/* ---- 2) fetchBodySection：优先委派 adapter.getSection ---- */
if (!src.includes('adapter.getSection')) {
  const anchor = `async function fetchBodySection(message, section, adapter) {\n  const upper = section.toUpperCase();`;
  if (src.includes(anchor)) {
    src = src.replace(
      anchor,
      `async function fetchBodySection(message, section, adapter) {\n` +
      `  if (typeof adapter.getSection === "function") {\n` +
      `    const delegated = await adapter.getSection(message, section);\n` +
      `    if (delegated !== void 0) return delegated;\n` +
      `  }\n` +
      `  const upper = section.toUpperCase();`,
    );
    applied++;
  } else {
    console.warn('[patch] fetchBodySection 锚点未匹配，需人工检查');
  }
} else {
  console.log('[patch] fetchBodySection 已委派 getSection，跳过');
}

/* ---- 3) 兜底：BODY[TEXT] / HEADER.FIELDS 至少按头/体切分 ---- */
const sectionOld = `async function fetchBodySection(message, section, adapter) {
  const upper = section.toUpperCase();
  if (upper === "" || upper === "TEXT") {
    const key = message.blobKeyText ?? message.blobKeyHtml ?? message.blobKeyRaw;
    return adapter.getBlob(key);
  }
  if (upper === "HEADER") {`;
const sectionNew = `async function fetchBodySection(message, section, adapter) {
  const upper = section.toUpperCase();
  const rawBody = () => adapter.getBlob(message.blobKeyText ?? message.blobKeyHtml ?? message.blobKeyRaw);
  const rawString = async () => {
    const buf = await rawBody();
    return Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf);
  };
  if (upper === "") {
    return rawBody();
  }
  if (upper === "TEXT") {
    const s = await rawString();
    const i = s.indexOf("\\r\\n\\r\\n");
    return i === -1 ? s : s.slice(i + 4);
  }
  if (upper === "HEADER" || upper.startsWith("HEADER.FIELDS")) {
    const s = await rawString();
    const i = s.indexOf("\\r\\n\\r\\n");
    return i === -1 ? s : s.slice(0, i + 4);
  }
  if (false) {`;

if (src.includes(sectionOld)) {
  src = src.replace(sectionOld, sectionNew);
  applied++;
} else if (src.includes('rawBody')) {
  console.log('[patch] 兜底切分已是补丁版，跳过');
}

/* ---- 4) 兜底末尾 return 也走 rawBody() ---- */
if (!src.includes('  return rawBody();\n}\nfunction parseFetchArgs')) {
  src = src.replace(
    `  return adapter.getBlob(message.blobKeyRaw);
}
function parseFetchArgs`,
    `  return rawBody();
}
function parseFetchArgs`,
  );
}

if (src !== before) {
  fs.writeFileSync(target, src, 'utf8');
  console.log(`[patch] 已应用 ${applied} 组补丁 → ${path.relative(process.cwd(), target)}`);
} else {
  console.log('[patch] 无需改动（已是补丁版）');
}

/* ---- 5) UID FETCH 响应必须带 UID（RFC 3501 §6.4.8）---- */
let src2 = fs.readFileSync(target, 'utf8');
const src2Before = src2;
if (src2.includes('effectiveItems')) {
  console.log('[patch] UID 强制回填已是补丁版，跳过');
} else {
  const anchorUid = `  const messages = await adapter.getMessagesByIds(messageIds);\n  const responses = [];`;
  if (src2.includes(anchorUid)) {
    src2 = src2.replace(
      anchorUid,
      `  const messages = await adapter.getMessagesByIds(messageIds);\n` +
      `  const effectiveItems = isUidCommand && !parsed.items.includes("UID") ? [...parsed.items, "UID"] : parsed.items;\n` +
      `  const responses = [];`,
    );
    src2 = src2.replace(
      `await buildFetchResponse(message, uid, parsed.items, adapter);`,
      `await buildFetchResponse(message, uid, effectiveItems, adapter);`,
    );
    console.log('[patch] 已应用 UID 强制回填');
  } else {
    console.warn('[patch] handleFetch 锚点未匹配，需人工检查');
  }
}
if (src2 !== src2Before) fs.writeFileSync(target, src2, 'utf8');

/* ---- 6) 支持 RFC822 / RFC822.HEADER / RFC822.TEXT 宏 ---- */
if (!fs.existsSync(parseTarget)) {
  console.warn(`[patch] 未找到 ${parseTarget}，跳过 RFC822 宏补丁`);
} else {
  const src3Before = fs.readFileSync(parseTarget, 'utf8');
  let src3 = src3Before;
  if (src3.includes('RFC822.HEADER')) {
    console.log('[patch] RFC822 宏已是补丁版，跳过');
  } else {
    const anchorMacro = `  ["RFC822.SIZE", "RFC822.SIZE"],\n  ["UID", "UID"]`;
    if (src3.includes(anchorMacro)) {
      src3 = src3.replace(
        anchorMacro,
        `  ["RFC822.SIZE", "RFC822.SIZE"],\n` +
        `  ["RFC822.HEADER", { type: "BODY", section: "HEADER", peek: true }],\n` +
        `  ["RFC822.TEXT", { type: "BODY", section: "TEXT", peek: true }],\n` +
        `  ["RFC822", { type: "BODY", section: "", peek: true }],\n` +
        `  ["UID", "UID"]`,
      );
      console.log('[patch] 已应用 RFC822 宏映射');
    } else {
      console.warn('[patch] SIMPLE_FETCH_ITEMS 锚点未匹配，需人工检查');
    }
  }
  if (src3 !== src3Before) fs.writeFileSync(parseTarget, src3, 'utf8');
}

/* ---- 7) STORE 移除 \Seen / \Flagged 时必须回写字段 ----
   库的 imapFlagsToMailFields 只在标志**存在**时写字段：`STORE -FLAGS (\Seen)` 的新标志集为空，
   fields 就是 {}，updateMessageFlags 什么也不做 → 客户端「标为未读 / 取消星标」静默失效。 */
{
  const before7 = fs.readFileSync(target, 'utf8');
  let src4 = before7;
  if (src4.includes('[S37] 按更新后的完整标志集回写')) {
    console.log('[patch] STORE 标志回写已是补丁版，跳过');
  } else {
    const anchorStore = `    const { fields } = imapFlagsToMailFields(newFlags);\n    await adapter.updateMessageFlags(msgId, fields);`;
    if (src4.includes(anchorStore)) {
      src4 = src4.replace(
        anchorStore,
        `    const { fields } = imapFlagsToMailFields(newFlags);\n` +
        `    // [S37] 按更新后的完整标志集回写（库只在标志存在时写字段，移除时 fields 为空）\n` +
        `    fields.isRead = newFlags.includes("\\\\Seen");\n` +
        `    fields.isStarred = newFlags.includes("\\\\Flagged");\n` +
        `    await adapter.updateMessageFlags(msgId, fields);`,
      );
      console.log('[patch] 已应用 STORE 标志回写');
    } else {
      console.warn('[patch] handleStore 锚点未匹配，需人工检查');
    }
  }
  if (src4 !== before7) fs.writeFileSync(target, src4, 'utf8');
}

/* ---- 8) 支持 BODY[...]<start.count> 部分取（RFC 3501 §6.4.8）----
   库把 partial 解析出来了却完全不用：请求 1024 字节却回整段，响应标签也没有 `<start>`。
   Apple Mail 靠部分取拼首屏正文/摘要，拿不到 `<start>` 会认为数据对不上 →「此邮件中没有内容」。 */
{
  const before8 = fs.readFileSync(target, 'utf8');
  let src5 = before8;
  if (src5.includes('item.partial.offset')) {
    console.log('[patch] 部分取已是补丁版，跳过');
  } else {
    const anchorPartial = `      const content = await fetchBodySection(message, item.section, adapter);\n      if (content !== void 0) {\n        data.body = { section: item.section, content };\n      }`;
    if (src5.includes(anchorPartial)) {
      src5 = src5.replace(
        anchorPartial,
        `      let content = await fetchBodySection(message, item.section, adapter);\n` +
        `      if (content !== void 0) {\n` +
        `        // [S37] 按 <start.count> 切片（按字节切，避免多字节错位）\n` +
        `        if (item.partial) {\n` +
        `          const whole = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");\n` +
        `          content = whole.subarray(item.partial.offset, item.partial.offset + item.partial.count).toString("utf8");\n` +
        `        }\n` +
        `        data.body = { section: item.section, content, partial: item.partial };\n` +
        `      }`,
      );
      console.log('[patch] 已应用部分取切片');
    } else {
      console.warn('[patch] buildFetchResponse 锚点未匹配，需人工检查');
    }
  }
  if (src5 !== before8) fs.writeFileSync(target, src5, 'utf8');
}

/* ---- 9) FETCH 响应标签回带部分取起点 BODY[1]<0> ---- */
{
  const fmtTarget = path.join(distDir, 'chunk-OTGCZ56Q.js');
  if (!fs.existsSync(fmtTarget)) {
    console.warn('[patch] 未找到 FETCH 响应格式化文件，跳过 origin 回带');
  } else {
    const before9 = fs.readFileSync(fmtTarget, 'utf8');
    let src6 = before9;
    if (src6.includes('data.body.partial') || src6.includes('bodyItem.partial')) {
      console.log('[patch] origin 回带已是补丁版，跳过');
    } else {
      const anchorFmt = `    const byteLength = new TextEncoder().encode(content).byteLength;\n    parts.push(\`\${sectionStr} {\${byteLength}}\${CRLF}\${content}\`);`;
      if (src6.includes(anchorFmt)) {
        src6 = src6.replace(
          anchorFmt,
          `    const originTag = data.body.partial ? \`<\${data.body.partial.offset}>\` : "";\n` +
          `    const byteLength = new TextEncoder().encode(content).byteLength;\n` +
          `    parts.push(\`\${sectionStr}\${originTag} {\${byteLength}}\${CRLF}\${content}\`);`,
        );
        console.log('[patch] 已应用 origin 回带');
      } else {
        console.warn('[patch] formatFetchResponse 锚点未匹配，需人工检查');
      }
    }
    if (src6 !== before9) fs.writeFileSync(fmtTarget, src6, 'utf8');
  }
}

/* ---- 10) 一次 FETCH 里的多个 BODY 段必须全部回（原来只保留最后一个）----
   库的 buildFetchResponse 只有单个槽位 `data.body = {...}`，循环里后一个段直接覆盖前一个。
   实测 Apple Mail 会发 `(BODY.PEEK[1] BODY.PEEK[2])`、`(BODY.PEEK[1.1] BODY.PEEK[2])`：
     - 单段 HTML 邮件：只回 BODY[2] {0} → 正文 56332 字节一个没发 →「此邮件中没有内容」
     - HTML+PDF 邮件：只回 BODY[2]（PDF 225233 字节）→ 客户端把 PDF 当正文 → 整屏乱码 */
{
  const before10 = fs.readFileSync(target, 'utf8');
  let s10 = before10;
  if (s10.includes('data.bodies || (data.bodies = [])')) {
    console.log('[patch] 多段正文已是补丁版，跳过');
  } else {
    // 10.1 部分取切片：截断落在多字节字符中间会变替换字符并撑大字节数，回退到安全边界
    const anchorSlice = '          content = whole.subarray(item.partial.offset, item.partial.offset + item.partial.count).toString("utf8");';
    if (s10.includes(anchorSlice)) {
      s10 = s10.replace(
        anchorSlice,
        '          let sliced = whole.subarray(item.partial.offset, item.partial.offset + item.partial.count).toString("utf8");\n' +
        '          // [S37] 截断可能落在多字节字符中间，回退到不超过 count 的安全边界\n' +
        '          while (Buffer.byteLength(sliced, "utf8") > item.partial.count && sliced.length > 0) {\n' +
        '            sliced = sliced.slice(0, -1);\n' +
        '          }\n' +
        '          content = sliced;',
      );
      console.log('[patch] 已应用部分取安全边界');
    } else {
      console.warn('[patch] 部分取切片锚点未匹配，需人工检查');
    }
    // 10.2 单槽位 → 累积数组
    const anchorSlot = '        data.body = { section: item.section, content, partial: item.partial };';
    if (s10.includes(anchorSlot)) {
      s10 = s10.replace(
        anchorSlot,
        '        // [S37] 一次 FETCH 可含多个 BODY 段（BODY[1] + BODY[2]），必须全保留；\n' +
        '        // 原来写死单个 data.body，后段覆盖前段 → 客户端只拿到最后一个段（PDF 当正文=乱码 / 正文丢失=空白）\n' +
        '        (data.bodies || (data.bodies = [])).push({ section: item.section, content, partial: item.partial });\n' +
        '        data.body = data.bodies[data.bodies.length - 1];',
      );
      console.log('[patch] 已应用多段正文累积');
    } else {
      console.warn('[patch] data.body 槽位锚点未匹配，需人工检查');
    }
  }
  if (s10 !== before10) fs.writeFileSync(target, s10, 'utf8');
}

/* ---- 12) server 端协议诚实性（v0.2.11）----
   CAPABILITY 里声明了 NAMESPACE / ID，但 server 的命令分派里根本没有这两条 →
   客户端一问就吃 BAD Unknown command（部分客户端因此拿不到文件夹层级，直接不显示信箱）。
   另外 CREATE/DELETE/RENAME/SUBSCRIBE 落在 default 也回 BAD；
   cloud-mail 只有固定系统文件夹，正确应答是 NO（带原因），不是协议错误。
   CHECK 是 RFC 3501 §6.3.5 的 no-op，必须回 OK —— Thunderbird 会定期发。 */
{
  const srvTarget = path.join(here, '..', 'node_modules', '@rafters', 'mail-imap-server', 'dist', 'index.js');
  if (!fs.existsSync(srvTarget)) {
    console.warn('[patch] 未找到 mail-imap-server/dist/index.js，跳过协议诚实性补丁');
  } else {
    const before12 = fs.readFileSync(srvTarget, 'utf8');
    let s12 = before12;
    // 库的响应行**自带结尾 CRLF**（formatTagged / formatUntagged），server 只做 lines.join("")，
    // 所以手写的 untagged 行必须自己补 \r\n，否则会和下一行粘成一行，客户端认不出 tag 直接卡死。
    if (s12.includes('NIL NIL\\r\\n')) {
      console.log('[patch] 协议诚实性已是补丁版，跳过');
    } else {
      const anchorDefault = [
        '      case "UID":',
        '        return handleUidCommand(tag, args, state);',
        '      default:',
      ].join('\n');
      if (s12.includes(anchorDefault)) {
        s12 = s12.replace(
          anchorDefault,
          [
            '      case "UID":',
            '        return handleUidCommand(tag, args, state);',
            '      // [S37] CAPABILITY 声明了就必须应答，否则客户端吃 BAD',
            '      case "NAMESPACE":',
            '        return { lines: [\'* NAMESPACE (("" "/")) NIL NIL\\r\\n\', formatTagged(tag, "OK", "NAMESPACE completed")], disconnect: false };',
            '      case "ID":',
            '        return { lines: [\'* ID ("name" "cloud-mail-imap" "version" "0.2.14")\\r\\n\', formatTagged(tag, "OK", "ID completed")], disconnect: false };',
            '      case "CHECK":',
            '        return { lines: [formatTagged(tag, "OK", "CHECK completed")], disconnect: false };',
            '      // [S37] 站内只有固定系统文件夹：CREATE 等命令回 NO（带原因），不谎报能力',
            '      case "CREATE":',
            '      case "DELETE":',
            '      case "RENAME":',
            '      case "SUBSCRIBE":',
            '      case "UNSUBSCRIBE":',
            '        return { lines: [formatTagged(tag, "NO", `${command} not supported: cloud-mail uses fixed system folders`)], disconnect: false };',
            '      default:',
          ].join('\n'),
        );
        console.log('[patch] 已应用协议诚实性（NAMESPACE / ID / CHECK / CREATE 等）');
      } else {
        console.warn('[patch] server 命令分派 default 锚点未匹配，需人工检查');
      }
    }
    // 版本号始终对齐 package.json（幂等：已是当前版本时字符串不变）
    s12 = s12.replace(/"name" "cloud-mail-imap" "version" "[^"]*"/g, `"name" "cloud-mail-imap" "version" "${PKG_VERSION}"`);
    if (s12 !== before12) fs.writeFileSync(srvTarget, s12, 'utf8');
  }
}

/* ---- 11) 格式化：遍历 data.bodies 逐段输出 ---- */
{
  const fmtTarget2 = path.join(distDir, 'chunk-OTGCZ56Q.js');
  if (!fs.existsSync(fmtTarget2)) {
    console.warn('[patch] 未找到 FETCH 响应格式化文件，跳过多段输出');
  } else {
    const before11 = fs.readFileSync(fmtTarget2, 'utf8');
    let s11 = before11;
    if (s11.includes('data.bodies !== void 0 ? data.bodies')) {
      console.log('[patch] 多段输出已是补丁版，跳过');
    } else {
      const anchorWhole = [
        '  if (data.body !== void 0) {',
        '    const { section, content } = data.body;',
        '    const sectionStr = section.length > 0 ? `BODY[${section}]` : "BODY[]";',
        '    const originTag = data.body.partial ? `<${data.body.partial.offset}>` : "";',
        '    const byteLength = new TextEncoder().encode(content).byteLength;',
        '    parts.push(`${sectionStr}${originTag} {${byteLength}}${CRLF}${content}`);',
        '  }',
      ].join('\n');
      if (s11.includes(anchorWhole)) {
        // 整块替换，避免分段替换漏掉块的闭括号
        s11 = s11.replace(
          anchorWhole,
          [
            '  if (data.body !== void 0) {',
            '    // [S37] 多个 BODY 段逐个输出（原来只输出最后一个，正文会被附件覆盖）',
            '    const bodyList = data.bodies !== void 0 ? data.bodies : [data.body];',
            '    for (const bodyItem of bodyList) {',
            '      const { section, content } = bodyItem;',
            '      const sectionStr = section.length > 0 ? `BODY[${section}]` : "BODY[]";',
            '      const originTag = bodyItem.partial ? `<${bodyItem.partial.offset}>` : "";',
            '      const byteLength = new TextEncoder().encode(content).byteLength;',
            '      parts.push(`${sectionStr}${originTag} {${byteLength}}${CRLF}${content}`);',
            '    }',
            '  }',
          ].join('\n'),
        );
        console.log('[patch] 已应用多段输出');
      } else {
        console.warn('[patch] formatFetchResponse 正文块锚点未匹配，需人工检查');
      }
    }
    if (s11 !== before11) fs.writeFileSync(fmtTarget2, s11, 'utf8');
  }
}

/* ---- 13) EXPUNGE 判定：站内删除 = 移入回收站（v0.2.14）----
   handleExpunge 只把 `message.deletedAt !== null` 的邮件纳入 expunge，而我们的
   toMessageData 里 deletedAt 恒为 null（站内没有「只打标记不移走」的中间态）。
   结果：STORE \Deleted 已经把信移进回收站，客户端随后发 EXPUNGE 收到的却是
   「没有任何 * n EXPUNGE」的空应答 → 列表里一直挂着已删的幽灵条目，直到重新 SELECT。
   正确判定：消息已经从本文件夹消失（getMessage 返回 undefined）也算已删除。 */
{
  // 必须从磁盘重读：前面各组各自独立读写 target，共用顶部的 src 会互相覆盖
  const before13 = fs.readFileSync(target, 'utf8');
  let s13 = before13;
  if (s13.includes('[S37-expunge]')) {
    console.log('[patch] EXPUNGE 判定已是补丁版，跳过');
  } else {
    const anchor = [
      '    const message = await adapter.getMessage(msgId);',
      '    if (message !== void 0 && message.deletedAt !== null) {',
      '      toExpunge.push(uid);',
      '    }',
    ].join('\n');
    const anchorDelete = [
      '    await adapter.deleteMessage(msgId);',
      '    const formerSeq = uidMap.expungeUid(uid);',
    ].join('\n');
    if (s13.includes(anchor) && s13.includes(anchorDelete)) {
      s13 = s13.replace(
        anchor,
        [
          '    const message = await adapter.getMessage(msgId);',
          '    // [S37-expunge] 站内删除=移入回收站，邮件随即从本文件夹消失（getMessage 回 undefined）；',
          '    // 旧判定只看 deletedAt → EXPUNGE 永远空集。',
          '    if (message === void 0 || message.deletedAt !== null) {',
          '      toExpunge.push(uid);',
          '    }',
        ].join('\n'),
      );
      s13 = s13.replace(
        anchorDelete,
        [
          '    // [S37-expunge] 只有仍带 \\Deleted 的才调删除接口；已不在本文件夹的只回收序号，避免重复删',
          '    const stillThere = await adapter.getMessage(msgId);',
          '    if (stillThere !== void 0 && stillThere.deletedAt !== null) {',
          '      await adapter.deleteMessage(msgId);',
          '    }',
          '    const formerSeq = uidMap.expungeUid(uid);',
        ].join('\n'),
      );
      applied += 1;
      console.log('[patch] 已应用 EXPUNGE 判定（消失即已删）');
    } else {
      console.warn('[patch] handleExpunge 锚点未匹配，需人工检查');
    }
  }
  if (s13 !== before13) fs.writeFileSync(target, s13, 'utf8');
}

/* ---- 15) BODY[...]（非 PEEK）隐式设 \Seen（RFC 3501 §6.4.5）（v0.2.14）----
   RFC 规定取正文的 BODY[] 等价于「取 + 标已读」，BODY.PEEK[] 才是只读不标。
   库只解析出 item.peek 但从不使用 → 依赖隐式行为的客户端（部分 Foxmail/老版本）
   点开邮件后仍显示未读，反复重取正文。 -- 注意此处逻辑放在 handleFetch 里。 */
{
  const before15 = fs.readFileSync(target, 'utf8');
  let s15 = before15;
  if (s15.includes('[S37-implicitseen]')) {
    console.log('[patch] 隐式 \\Seen 已是补丁版，跳过');
  } else {
    const anchor = [
      '    const fetchData = await buildFetchResponse(message, uid, effectiveItems, adapter);',
      '    responses.push(formatFetchResponse(seq, fetchData));',
    ].join('\n');
    if (s15.includes(anchor)) {
      s15 = s15.replace(
        anchor,
        [
          '    const fetchData = await buildFetchResponse(message, uid, effectiveItems, adapter);',
          '    responses.push(formatFetchResponse(seq, fetchData));',
          '    // [S37-implicitseen] 非 PEEK 的 BODY[...] 按 RFC 3501 §6.4.5 应隐式设 \\Seen',
          '    try {',
          '      const wantsBody = effectiveItems.some((it) => it && it.type === "BODY" && it.peek === false);',
          '      if (wantsBody && !session.isReadOnly() && message.isRead !== true) {',
          '        await adapter.updateMessageFlags(message.id, { isRead: true });',
          '      }',
          '    } catch (e) { /* 标记失败不影响本次 FETCH 结果 */ }',
        ].join('\n'),
      );
      applied += 1;
      console.log('[patch] 已应用 BODY[] 隐式设 Seen');
    } else {
      console.warn('[patch] handleFetch 响应锚点未匹配，需人工检查');
    }
  }
  if (s15 !== before15) fs.writeFileSync(target, s15, 'utf8');
}

/* ---- 14) server 端补 UID EXPUNGE（CAPABILITY 宣告了 UIDPLUS 就必须应答）（v0.2.14）----
   实测 `UID EXPUNGE 1:*` → `BAD Unknown UID subcommand`。Apple Mail 支持 UIDPLUS，
   用户在客户端删单封邮件时走的就是这条路，GET BAD 之后会认为删除失败。 */
{
  const srvTarget3 = path.join(here, '..', 'node_modules', '@rafters', 'mail-imap-server', 'dist', 'index.js');
  if (!fs.existsSync(srvTarget3)) {
    console.warn('[patch] 未找到 mail-imap-server/dist/index.js，跳过 UID EXPUNGE');
  } else {
    const before14 = fs.readFileSync(srvTarget3, 'utf8');
    let s14 = before14;
    if (s14.includes('[S37-uidexpunge]')) {
      console.log('[patch] UID EXPUNGE 已是补丁版，跳过');
    } else {
      const uidDefault = [
        '        default:',
        '          return Promise.resolve([',
        '            formatTagged(tag, "BAD", `Unknown UID subcommand: ${subcommand}`)',
        '          ]);',
      ].join('\n');
      if (s14.includes(uidDefault)) {
        s14 = s14.replace(
          uidDefault,
          [
            '        // [S37-uidexpunge] UIDPLUS 的核心命令，客户端删单封邮件必用',
            '        case "EXPUNGE": {',
            '          if (session.isReadOnly()) {',
            '            return Promise.resolve([formatTagged(tag, "NO", "Mailbox is read-only (EXAMINE)")]);',
            '          }',
            '          const setStr = subargs.trim();',
            '          if (!setStr) {',
            '            return Promise.resolve([formatTagged(tag, "BAD", "UID EXPUNGE requires a uid set")]);',
            '          }',
            '          return (async () => {',
            '            // 先把集合收敛成区间，再拿现有 UID 取交集 —— 不能把 `1:*` 展开成十万个序号逐个查，',
            '            // 那样客户端一次 "UID EXPUNGE 1:*" 就会卡几十秒。',
            '            const ranges = [];',
            '            for (const piece of setStr.split(",")) {',
            '              const m = piece.trim().match(/^(\\d+)(?::(\\d+|\\*))?$/);',
            '              if (!m) continue;',
            '              const lo = Number(m[1]);',
            '              const hi = m[2] === undefined ? lo : (m[2] === "*" ? Number.MAX_SAFE_INTEGER : Number(m[2]));',
            '              ranges.push([Math.min(lo, hi), Math.max(lo, hi)]);',
            '            }',
            '            if (!ranges.length) {',
            '              return [formatTagged(tag, "BAD", "UID EXPUNGE requires a valid uid set")];',
            '            }',
            '            const inSet = (u) => ranges.some((r) => u >= r[0] && u <= r[1]);',
            '            const wanted = [];',
            '            for (let seq = 1; seq <= uidMap.totalMessages(); seq++) {',
            '              const u = uidMap.sequenceToUid(seq);',
            '              if (u !== void 0 && inSet(u)) wanted.push(u);',
            '            }',
            '            const targets = [];',
            '            // 分批并发查详情：逐封串行跨境 HTTP，16 封就要十几秒，"UID EXPUNGE 1:*" 会让',
            '            // 客户端以为服务器卡死（实测 12 秒还没回）。批大小与 adapter 的 DETAIL_CONCURRENCY 一致。',
            '            const BATCH = 6;',
            '            for (let i = 0; i < wanted.length; i += BATCH) {',
            '              const batch = wanted.slice(i, i + BATCH);',
            '              const flags = await Promise.all(batch.map(async (uid) => {',
            '                const mid = uidMap.uidToMessageId(uid);',
            '                if (mid === undefined) return null;',
            '                try {',
            '                  const msg = await adapters.messageAdapter.getMessage(mid);',
            '                  return (msg === void 0 || msg.deletedAt !== null) ? uid : null;',
            '                } catch (e) {',
            '                  return null;',
            '                }',
            '              }));',
            '              for (const u of flags) if (u !== null) targets.push(u);',
            '            }',
            '            targets.sort((a, b) => b - a);',
            '            const out = [];',
            '            for (const uid of targets) {',
            '              const mid = uidMap.uidToMessageId(uid);',
            '              if (mid === undefined) continue;',
            '              const msg = await adapters.messageAdapter.getMessage(mid);',
            '              if (msg !== void 0 && msg.deletedAt !== null) {',
            '                await adapters.messageAdapter.deleteMessage(mid);',
            '              }',
            '              const formerSeq = uidMap.expungeUid(uid);',
            '              if (formerSeq !== void 0) out.push(`* ${formerSeq} EXPUNGE\\r\\n`);',
            '            }',
            '            out.push(formatTagged(tag, "OK", "UID EXPUNGE completed"));',
            '            return out;',
            '          })();',
            '        }',
            '        default:',
            '          return Promise.resolve([',
            '            formatTagged(tag, "BAD", `Unknown UID subcommand: ${subcommand}`)',
            '          ]);',
          ].join('\n'),
        );
        console.log('[patch] 已应用 UID EXPUNGE');
      } else {
        console.warn('[patch] handleUidCommand default 锚点未匹配，需人工检查');
      }
    }
    if (s14 !== before14) fs.writeFileSync(srvTarget3, s14, 'utf8');
  }
}

/* ---- 16) FLAGS / PERMANENTFLAGS 允许适配器覆盖（v0.2.14）----
   库在 handleSelect / handleExamine 里把 flags 硬编码成 SUPPORTED_FLAGS + '\*'，
   完全不看 adapter.getFolderStats() 的返回值 —— 于是客户端被告知「可以给邮件打任意关键字」，
   而站内 STORE 只认 \Seen / \Flagged / \Deleted，其余静默丢弃（用户打了「已答复」刷新就没了）。
   改成 stats 可覆盖，由 adapters.js 只声明真实支持的三个。 */
{
  const flagTarget = path.join(distDir, 'chunk-OKC6C6F4.js');
  if (!fs.existsSync(flagTarget)) {
    console.warn('[patch] 未找到 SELECT/EXAMINE 应答文件，跳过 FLAGS 覆盖');
  } else {
    const before16 = fs.readFileSync(flagTarget, 'utf8');
    let s16 = before16;
    if (s16.includes('[S37-flags]')) {
      console.log('[patch] FLAGS 覆盖已是补丁版，跳过');
    } else {
      const flagAnchor = [
        '    flags: [...SUPPORTED_FLAGS],',
        '    permanentFlags: [...PERMANENT_FLAGS],',
      ].join('\n');
      const count = s16.split(flagAnchor).length - 1;
      if (count > 0) {
        s16 = s16.split(flagAnchor).join([
          '    // [S37-flags] 允许 adapter 只声明真实支持的标志（默认仍是库的全集）',
          '    flags: (stats.flags !== void 0 ? stats.flags : [...SUPPORTED_FLAGS]),',
          '    permanentFlags: (stats.permanentFlags !== void 0 ? stats.permanentFlags : [...PERMANENT_FLAGS]),',
        ].join('\n'));
        console.log(`[patch] 已应用 FLAGS 覆盖（SELECT/EXAMINE 共 ${count} 处）`);
      } else {
        console.warn('[patch] FLAGS 常量锚点未匹配，需人工检查');
      }
    }
    if (s16 !== before16) fs.writeFileSync(flagTarget, s16, 'utf8');
  }
}

/* ---- 17) SEARCH 补 HEADER / KEYWORD / UNKEYWORD 语法（v0.2.14）----
   库的 parseCriterion 没有这三个 case，落到 default 当序号解析失败 → 直接 BAD。
   而 HEADER <field> <value> 是 RFC 3501 §6.4.4 的标准语法（Thunderbird 的自定义头搜索、
   不少客户端的「按 Message-ID 查重」都会发），KEYWORD/UNKEYWORD 也是标准项。
   站内没有任何自定义关键字，所以 KEYWORD 恒不匹配、UNKEYWORD 恒匹配（语义诚实）。 */
{
  const parseTarget2 = path.join(distDir, 'chunk-EYMWACFL.js');
  if (!fs.existsSync(parseTarget2)) {
    console.warn('[patch] 未找到 SEARCH 解析文件，跳过 HEADER/KEYWORD');
  } else {
    const before17 = fs.readFileSync(parseTarget2, 'utf8');
    let s17 = before17;
    if (s17.includes('[S37-searchkw]')) {
      console.log('[patch] HEADER/KEYWORD 已是补丁版，跳过');
    } else {
      const kwAnchor = [
        '      case "UID":',
        '        return { type: "uid", set: parseSequenceSet(next()) };',
        '      case "NOT":',
      ].join('\n');
      if (s17.includes(kwAnchor)) {
        s17 = s17.replace(kwAnchor, [
          '      // [S37-searchkw] 标准语法，库里缺这三个 case 会直接 BAD',
          '      case "HEADER":',
          '        return { type: "header", field: String(next()).toLowerCase(), value: next() };',
          '      case "KEYWORD":',
          '        next(); // 吞掉关键字名：站内没有自定义关键字，恒不匹配',
          '        return { type: "flag", flag: "\\\\Keyword", negated: false };',
          '      case "UNKEYWORD":',
          '        next();',
          '        return { type: "flag", flag: "\\\\Keyword", negated: true };',
          '      case "UID":',
          '        return { type: "uid", set: parseSequenceSet(next()) };',
          '      case "NOT":',
        ].join('\n'));
        console.log('[patch] 已应用 SEARCH HEADER / KEYWORD / UNKEYWORD');
      } else {
        console.warn('[patch] parseCriterion UID 锚点未匹配，需人工检查');
      }
    }
    if (s17 !== before17) fs.writeFileSync(parseTarget2, s17, 'utf8');
  }
}

/* ---- 18) literal（{n} 同步 / {n+} 非同步）支持 ----
   实测缺陷：发 `UID SEARCH SUBJECT {3}` 时服务端既不回 "+"，又把命令当空条件执行，
   随后那 3 个字节被当成下一条命令 → BAD 污染会话；`{3+}` 直接 BAD。
   RFC 3501 要求所有 IMAP4rev1 服务器都必须支持 literal，而 Apple Mail / Thunderbird
   搜索中文时必用 literal（非 ASCII 无法放进 quoted string）。这里在 socket 层按字节实现。 */
{
  const serverTarget = path.join(serverDist, 'index.js');
  if (!fs.existsSync(serverTarget)) {
    console.warn('[patch] 未找到 @rafters/mail-imap-server，跳过 literal');
  } else {
    let s18 = fs.readFileSync(serverTarget, 'utf8');
    const before18 = s18;
    if (s18.includes('[S37-literal]')) {
      console.log('[patch] literal 已是补丁版，跳过');
    } else {
      const oldData = [
        '    socket.on("data", (data) => {',
        '      state.buffer += data.toString("utf-8");',
        '      if (state.buffer.length > MAX_BUFFER_SIZE) {',
        '        socket.write(formatBye("Buffer size exceeded"));',
        '        socket.destroy();',
        '        return;',
        '      }',
        '      const lines = state.buffer.split("\\r\\n");',
        '      state.buffer = lines.pop() ?? "";',
        '      for (const line of lines) {',
        '        if (line.length === 0) continue;',
        '        timeout.refresh();',
        '        processLine(line, state, socket).catch(() => {',
        '          socket.write(formatTagged("*", "BAD", "Internal server error"));',
        '        });',
        '      }',
        '    });',
      ].join('\n');
      if (!s18.includes(oldData)) {
        console.warn('[patch] socket.on("data") 锚点未匹配，需人工检查 literal');
      } else {
        const newData = String.raw`    // [S37-literal] RFC 3501 §4.3 / RFC 2088：literal 必须按字节读。
    // 原实现把数据直接 split 成行，完全不认 literal：客户端发「UID SEARCH SUBJECT {3}」时
    // 服务端既不回 "+"、还把命令当空条件执行，随后那 3 个字节变成下一条命令 → BAD 污染会话。
    // 中文/非 ASCII 搜索在 Apple Mail / Thunderbird 里必用 literal，所以必须补上。
    // 注意：不能先 toString("utf-8") 再按字符切行，多字节字符会让长度/位置算错。
    state.rbuf = Buffer.alloc(0);
    state.literal = null;
    socket.on("data", (data) => {
      state.rbuf = state.rbuf.length ? Buffer.concat([state.rbuf, data]) : data;
      if (state.rbuf.length > MAX_BUFFER_SIZE) {
        socket.write(formatBye("Buffer size exceeded"));
        socket.destroy();
        return;
      }
      for (;;) {
        if (state.literal) {
          const lit = state.literal;
          const take = Math.min(lit.need, state.rbuf.length);
          if (take > 0) {
            lit.chunks.push(state.rbuf.subarray(0, take));
            lit.need -= take;
            state.rbuf = state.rbuf.subarray(take);
          }
          if (lit.need > 0) return;
          const text = Buffer.concat(lit.chunks).toString("utf-8");
          const quoted = text.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/[\r\n]+/g, " ");
          state.buffer += '"' + quoted + '"';
          state.literal = null;
          continue;
        }
        const nl = state.rbuf.indexOf(10);
        if (nl < 0) return;
        let raw = state.rbuf.subarray(0, nl);
        state.rbuf = state.rbuf.subarray(nl + 1);
        if (raw.length > 0 && raw[raw.length - 1] === 13) raw = raw.subarray(0, raw.length - 1);
        const line = state.buffer + raw.toString("utf-8");
        state.buffer = "";
        const litMark = /\{(\d+)(\+)?\}$/.exec(line);
        if (litMark) {
          const need = Number(litMark[1]);
          if (need > MAX_BUFFER_SIZE) {
            socket.write(formatTagged("*", "BAD", "Literal too large"));
            continue;
          }
          if (!litMark[2]) socket.write("+ Ready for literal data\r\n");
          state.buffer = line.slice(0, litMark.index);
          state.literal = { need, chunks: [] };
          continue;
        }
        if (line.length === 0) continue;
        timeout.refresh();
        processLine(line, state, socket).catch(() => {
          socket.write(formatTagged("*", "BAD", "Internal server error"));
        });
      }
    });`;
        s18 = s18.replace(oldData, newData);
        console.log('[patch] 已应用 literal（同步 + 非同步）');
      }
    }
    if (s18 !== before18) fs.writeFileSync(serverTarget, s18, 'utf8');
  }
}

/* ---- 19) NOOP / IDLE 主动刷新 EXISTS ----
   实测缺陷：handleNoop 只回 OK、从不回 `* n EXISTS`；IDLE 能进但不能推（库的
   generateIdleNotification 从未被调用）。两者叠加 = 客户端挂着 IDLE 要等到超时重连
   才看得见新邮件。这里在 server 层补一个轻量刷新：数量变了推 EXISTS 并重建 uidMap。 */
{
  const serverTarget = path.join(serverDist, 'index.js');
  if (!fs.existsSync(serverTarget)) {
    console.warn('[patch] 未找到 @rafters/mail-imap-server，跳过 NOOP/IDLE');
  } else {
    let s19 = fs.readFileSync(serverTarget, 'utf8');
    const before19 = s19;
    if (s19.includes('[S37-live]')) {
      console.log('[patch] NOOP/IDLE 刷新已是补丁版，跳过');
    } else {
      // 19a) state 增加 socket / exists / idleTimer
      const oldState = [
        '    const state = {',
        '      session: new ImapSession(),',
        '      uidMap: null,',
        '      mailboxId: null,',
        '      email: null,',
        '      idleState: null,',
        '      buffer: ""',
        '    };',
      ].join('\n');
      const newState = [
        '    const state = {',
        '      session: new ImapSession(),',
        '      uidMap: null,',
        '      mailboxId: null,',
        '      email: null,',
        '      idleState: null,',
        '      buffer: "",',
        '      // [S37-live] EXISTS 刷新用：socket 引用、上次已知数量、IDLE 轮询定时器',
        '      socket,',
        '      exists: -1,',
        '      idleTimer: null',
        '    };',
      ].join('\n');
      if (s19.includes(oldState)) {
        s19 = s19.replace(oldState, newState);
      } else {
        console.warn('[patch] state 初始化锚点未匹配，NOOP/IDLE 需人工检查');
      }

      // 19b) cleanup 清掉 IDLE 定时器
      const oldCleanup = [
        '    function cleanup() {',
        '      if (cleaned) return;',
        '      cleaned = true;',
        '      activeConnections.delete(entry);',
        '      clearTimeout(timeout);',
        '    }',
      ].join('\n');
      const newCleanup = [
        '    function cleanup() {',
        '      if (cleaned) return;',
        '      cleaned = true;',
        '      activeConnections.delete(entry);',
        '      clearTimeout(timeout);',
        '      if (state.idleTimer) { clearInterval(state.idleTimer); state.idleTimer = null; }',
        '    }',
      ].join('\n');
      if (s19.includes(oldCleanup)) {
        s19 = s19.replace(oldCleanup, newCleanup);
      } else {
        console.warn('[patch] cleanup 锚点未匹配，IDLE 定时器可能泄漏');
      }

      // 19c) 插入 refreshMailbox
      const processLineAnchor = '  async function processLine(line, state, socket) {';
      if (s19.includes(processLineAnchor)) {
        const refresh = String.raw`  // [S37-live] NOOP / IDLE 主动查一次邮箱：数量变了就推 EXISTS 并重建 uidMap。
  // 不重建 uidMap 的话客户端收到 EXISTS 后发 UID FETCH 新 UID 会拿不到（映射里没有）。
  // 失败静默：Worker 抖一下不能让 NOOP 报错，等下个周期再试。
  async function refreshMailbox(state) {
    const sock = state.socket;
    const sess = state.session;
    if (!sock || !state.uidMap || !sess || !sess.selectedFolder) return -1;
    const folderId = sess.selectedFolder.folderId;
    if (folderId === undefined) return -1;
    try {
      const stats = await adapters.mailboxAdapter.getFolderStats(folderId);
      const total = Number(stats && stats.messages);
      if (!Number.isFinite(total)) return -1;
      if (total === state.exists) return -1;
      state.exists = total;
      const uids = await adapters.mailboxAdapter.getMessageUids(folderId);
      if (Array.isArray(uids)) state.uidMap.load(uids);
      sock.write("* " + total + " EXISTS\r\n");
      return total;
    } catch {
      return -1;
    }
  }
`;
        s19 = s19.replace(processLineAnchor, refresh + processLineAnchor);
      } else {
        console.warn('[patch] processLine 锚点未匹配，无法插入 refreshMailbox');
      }

      // 19d) NOOP 分支改为先刷新
      const oldNoop = '      case "NOOP":\n        return { lines: handleNoop(tag, session), disconnect: false };';
      const newNoop = [
        '      case "NOOP": {',
        '        // [S37-live] 客户端靠 NOOP 轮询时必须能看到新邮件',
        '        const noopLines = handleNoop(tag, session);',
        '        await refreshMailbox(state);',
        '        return { lines: noopLines, disconnect: false };',
        '      }',
      ].join('\n');
      if (s19.includes(oldNoop)) {
        s19 = s19.replace(oldNoop, newNoop);
      } else {
        console.warn('[patch] NOOP 分支锚点未匹配');
      }

      // 19e) IDLE 分支启动轮询
      const oldIdle = [
        '      case "IDLE": {',
        '        const result = handleIdleStart(tag, session);',
        '        if (result.idleState) {',
        '          state.idleState = result.idleState;',
        '        }',
        '        return { lines: [result.response], disconnect: false };',
        '      }',
      ].join('\n');
      const newIdle = [
        '      case "IDLE": {',
        '        const result = handleIdleStart(tag, session);',
        '        if (result.idleState) {',
        '          state.idleState = result.idleState;',
        '          // [S37-live] RFC 2177：IDLE 期间必须能推 EXISTS。库只回了 "+ idling"，',
        '          // 这里挂一个 30 秒轮询（IDLE 期间不会处理别的命令，不存在并发）。',
        '          if (!state.idleTimer) {',
        '            state.idleTimer = setInterval(() => {',
        '              refreshMailbox(state).catch(() => {});',
        '            }, 30000);',
        '            if (typeof state.idleTimer.unref === "function") state.idleTimer.unref();',
        '          }',
        '        }',
        '        return { lines: [result.response], disconnect: false };',
        '      }',
      ].join('\n');
      if (s19.includes(oldIdle)) {
        s19 = s19.replace(oldIdle, newIdle);
      } else {
        console.warn('[patch] IDLE 分支锚点未匹配');
      }

      // 19f) DONE 后停掉轮询
      const oldDone = [
        '      if (isIdleDone(line)) {',
        '        socket.write(handleIdleDone(state.idleState));',
        '        state.idleState = null;',
      ].join('\n');
      const newDone = [
        '      if (isIdleDone(line)) {',
        '        socket.write(handleIdleDone(state.idleState));',
        '        state.idleState = null;',
        '        if (state.idleTimer) { clearInterval(state.idleTimer); state.idleTimer = null; }',
      ].join('\n');
      if (s19.includes(oldDone)) {
        s19 = s19.replace(oldDone, newDone);
      } else {
        console.warn('[patch] IDLE DONE 锚点未匹配');
      }

      // 19g) SELECT / EXAMINE 后记录初始数量（两处文本相同，全替）
      const oldSel = '        if (result.uidMap) state.uidMap = result.uidMap;';
      const newSel = [
        '        if (result.uidMap) {',
        '          state.uidMap = result.uidMap;',
        '          // [S37-live] 记下 SELECT 时的真实数量，避免第一次 NOOP 推重复 EXISTS',
        '          state.exists = typeof result.uidMap.totalMessages === "function" ? result.uidMap.totalMessages() : -1;',
        '        }',
      ].join('\n');
      if (s19.includes(oldSel)) {
        s19 = s19.split(oldSel).join(newSel);
      } else {
        console.warn('[patch] SELECT uidMap 锚点未匹配');
      }

      console.log('[patch] 已应用 NOOP / IDLE EXISTS 刷新');
    }
    if (s19 !== before19) fs.writeFileSync(serverTarget, s19, 'utf8');
  }
}

/* ---- 20) SEARCH 结果升序 ----
   RFC 3501 §6.4.4：SEARCH 返回的序号/UID 必须升序。适配器按列表接口顺序（最新在前）
   返回，直接透传会得到 414 411 409… 降序。 */
{
  let s20 = fs.readFileSync(target, 'utf8');
  const before20 = s20;
  if (s20.includes('[S37-seqs]')) {
    console.log('[patch] SEARCH 排序已是补丁版，跳过');
  } else {
    const searchAnchor = '  return [formatSearchResponse(results), formatTagged(tag, "OK", "SEARCH completed")];';
    if (s20.includes(searchAnchor)) {
      s20 = s20.replace(searchAnchor, [
        '  // [S37-seqs] RFC 3501 §6.4.4 要求升序',
        '  results.sort((a, b) => a - b);',
        searchAnchor,
      ].join('\n'));
      console.log('[patch] 已应用 SEARCH 结果升序');
    } else {
      console.warn('[patch] SEARCH return 锚点未匹配');
    }
  }
  if (s20 !== before20) fs.writeFileSync(target, s20, 'utf8');
}

/* ---- 21) SEARCH CHARSET 前缀 ----
   RFC 3501 §6.4.4 允许 `SEARCH CHARSET <name> ...`。Thunderbird / Outlook 搜中文必带这个前缀，
   库的 parseSearchCriteria 没有 CHARSET 分支 → 整条命令 BAD，客户端搜索直接报错。
   支持 UTF-8 / US-ASCII（站内正文本来就是 UTF-8），其它字符集按 RFC 回 NO [BADCHARSET]。 */
{
  let s21 = fs.readFileSync(parseTarget, 'utf8');
  const before21 = s21;
  if (s21.includes('[S37-charset]')) {
    console.log('[patch] SEARCH CHARSET 已是补丁版，跳过');
  } else {
    const csAnchor = 'function parseSearchCriteria(input) {\n  const criteria = [];';
    if (s21.includes(csAnchor)) {
      s21 = s21.replace(csAnchor, [
        'function parseSearchCriteria(input) {',
        '  // [S37-charset] RFC 3501 §6.4.4：SEARCH 允许前置 CHARSET <name>，库缺这个分支会整条 BAD',
        '  const __cs = /^\\s*CHARSET\\s+([^\\s]+)\\s+/i.exec(input);',
        '  if (__cs) {',
        '    const __name = __cs[1].toUpperCase();',
        '    if (__name !== "UTF-8" && __name !== "US-ASCII") {',
        '      const __err = new Error("BADCHARSET");',
        '      __err.badCharset = true;',
        '      throw __err;',
        '    }',
        '    input = input.slice(__cs[0].length);',
        '  }',
        '  const criteria = [];',
      ].join('\n'));
      console.log('[patch] 已应用 SEARCH CHARSET 解析');
    } else {
      console.warn('[patch] parseSearchCriteria 锚点未匹配');
    }
  }
  if (s21 !== before21) fs.writeFileSync(parseTarget, s21, 'utf8');

  let s21b = fs.readFileSync(target, 'utf8');
  const before21b = s21b;
  const badAnchor = [
    '  } catch {',
    '    return [formatTagged(tag, "BAD", "Invalid search criteria")];',
    '  }',
  ].join('\n');
  if (s21b.includes('[S37-charset]')) {
    console.log('[patch] SEARCH BADCHARSET 应答已是补丁版，跳过');
  } else if (s21b.includes(badAnchor)) {
    s21b = s21b.replace(badAnchor, [
      '  } catch (e) {',
      '    // [S37-charset] 不支持的字符集按 RFC 回 NO [BADCHARSET (...)]，客户端会自行降级',
      '    if (e && e.badCharset) {',
      '      return [formatTagged(tag, "NO", "[BADCHARSET (UTF-8 US-ASCII)] unsupported charset")];',
      '    }',
      '    return [formatTagged(tag, "BAD", "Invalid search criteria")];',
      '  }',
    ].join('\n'));
    console.log('[patch] 已应用 BADCHARSET 应答');
  } else {
    console.warn('[patch] handleSearch catch 锚点未匹配');
  }
  if (s21b !== before21b) fs.writeFileSync(target, s21b, 'utf8');
}

/* ---- 22) AUTHENTICATE PLAIN ----
   RFC 3501 §6.2.2 / RFC 4616：AUTHENTICATE 是必需命令，Outlook 与部分手机客户端优先用它，
   只认 LOGIN 会让这些客户端登录失败。这里在 server 侧加 PLAIN 机制（含两步握手），
   并在 CAPABILITY 里声明 AUTH=PLAIN（否则合规客户端不会发这条命令）。 */
{
  const authChunk = path.join(distDir, 'chunk-M4JQBSQY.js');
  let s22a = fs.readFileSync(authChunk, 'utf8');
  const before22a = s22a;
  if (s22a.includes('AUTH=PLAIN')) {
    console.log('[patch] CAPABILITY 已含 AUTH=PLAIN，跳过');
  } else {
    const capAnchor = [
      'var SERVER_CAPABILITIES = [',
      '  "IMAP4rev1",',
      '  "IDLE",',
      '  "LITERAL+",',
      '  "UIDPLUS",',
      '  "NAMESPACE",',
      '  "ID"',
      '];',
    ].join('\n');
    if (s22a.includes(capAnchor)) {
      s22a = s22a.replace(capAnchor, [
        'var SERVER_CAPABILITIES = [',
        '  "IMAP4rev1",',
        '  "IDLE",',
        '  "LITERAL+",',
        '  "UIDPLUS",',
        '  "NAMESPACE",',
        '  "ID",',
        '  // [S37-auth] 只实现 PLAIN，就只声明 PLAIN',
        '  "AUTH=PLAIN"',
        '];',
      ].join('\n'));
      console.log('[patch] 已应用 CAPABILITY AUTH=PLAIN');
    } else {
      console.warn('[patch] SERVER_CAPABILITIES 锚点未匹配');
    }
  }
  if (s22a !== before22a) fs.writeFileSync(authChunk, s22a, 'utf8');

  const serverTargetPath = path.join(serverDist, 'index.js');
  let s22 = fs.readFileSync(serverTargetPath, 'utf8');
  const before22 = s22;
  if (s22.includes('[S37-auth]')) {
    console.log('[patch] AUTHENTICATE 已是补丁版，跳过');
  } else {
    // 22a) state 增加握手等待位
    const stateAnchor = '      idleState: null,\n      buffer: "",';
    if (s22.includes(stateAnchor)) {
      s22 = s22.replace(stateAnchor, '      idleState: null,\n      // [S37-auth] AUTHENTICATE 等客户端发 base64 凭证的挂起位\n      authPending: null,\n      buffer: "",');
    } else {
      console.warn('[patch] state 初始化锚点未匹配');
    }

    // 22b) 注入 PLAIN 校验函数 + processLine 前置分支
    const plAnchor = '  async function processLine(line, state, socket) {\n    if (state.idleState?.active) {';
    if (s22.includes(plAnchor)) {
      s22 = s22.replace(plAnchor, [
        '  // [S37-auth] AUTHENTICATE PLAIN（RFC 4616）：两段式与带初始响应两种都支持',
        '  async function completePlainAuth(tag, base64, state) {',
        '    const sess = state.session;',
        '    const authStateError = sess.validateCommand("LOGIN");',
        '    if (authStateError !== null) {',
        '      return { lines: [formatTagged(tag, "NO", authStateError)], disconnect: false };',
        '    }',
        '    let raw = "";',
        '    try {',
        '      raw = Buffer.from(String(base64 || "").replace(/"/g, ""), "base64").toString("utf8");',
        '    } catch {',
        '      raw = "";',
        '    }',
        '    const parts = raw.split("\\u0000");',
        '    const authEmail = parts.length === 3 ? parts[1] : "";',
        '    const authPassword = parts.length === 3 ? parts[2] : "";',
        '    const authValid = authEmail && authPassword',
        '      ? await adapters.authAdapter.verifyAppPassword(authEmail, authPassword)',
        '      : false;',
        '    if (!authValid) {',
        '      const maxExceeded = sess.recordFailedLogin();',
        '      if (maxExceeded) {',
        '        return {',
        '          lines: [formatTagged(tag, "NO", "AUTHENTICATE failed"), formatBye("Too many failed login attempts")],',
        '          disconnect: true',
        '        };',
        '      }',
        '      return { lines: [formatTagged(tag, "NO", "AUTHENTICATE failed")], disconnect: false };',
        '    }',
        '    sess.authenticate();',
        '    state.email = authEmail;',
        '    state.mailboxId = (await config.resolveMailboxId(authEmail)) ?? null;',
        '    return { lines: [formatTagged(tag, "OK", "AUTHENTICATE completed")], disconnect: false };',
        '  }',
        '  async function processLine(line, state, socket) {',
        '    // [S37-auth] AUTHENTICATE 没带初始响应时，下一行就是 base64 凭证',
        '    if (state.authPending) {',
        '      const pendingAuth = state.authPending;',
        '      state.authPending = null;',
        '      const authText = String(line || "").trim();',
        '      if (authText === "*") {',
        '        socket.write(formatTagged(pendingAuth.tag, "BAD", "AUTHENTICATE cancelled"));',
        '        return;',
        '      }',
        '      const authResult = await completePlainAuth(pendingAuth.tag, authText, state);',
        '      for (const authLine of authResult.lines) socket.write(authLine);',
        '      if (authResult.disconnect) socket.end();',
        '      return;',
        '    }',
        '    if (state.idleState?.active) {',
      ].join('\n'));
      console.log('[patch] 已应用 AUTHENTICATE 握手与校验');
    } else {
      console.warn('[patch] processLine 锚点未匹配');
    }

    // 22c) 命令分发
    const logoutAnchor = '      case "LOGOUT": {';
    if (s22.includes(logoutAnchor)) {
      s22 = s22.replace(logoutAnchor, [
        '      case "AUTHENTICATE": {',
        '        // [S37-auth] 只提供 PLAIN；CAPABILITY 也只声明了 AUTH=PLAIN',
        '        const authParts = String(args || "").trim().split(/\\s+/).filter(Boolean);',
        '        const authMech = (authParts[0] || "").toUpperCase();',
        '        if (authMech !== "PLAIN") {',
        '          return { lines: [formatTagged(tag, "NO", "Unsupported authentication mechanism")], disconnect: false };',
        '        }',
        '        let authInitial = authParts.slice(1).join(" ").trim();',
        '        // literal 会被拼成 quoted string，AUTHENTICATE 两种形态都要认',
        '        if (authInitial.startsWith(\'"\') && authInitial.endsWith(\'"\')) {',
        '          authInitial = authInitial.slice(1, -1);',
        '        }',
        '        if (!authInitial) {',
        '          state.authPending = { tag };',
        '          return { lines: ["+ \\r\\n"], disconnect: false };',
        '        }',
        '        return completePlainAuth(tag, authInitial, state);',
        '      }',
        '      case "LOGOUT": {',
      ].join('\n'));
      console.log('[patch] 已应用 AUTHENTICATE 命令分发');
    } else {
      console.warn('[patch] LOGOUT 锚点未匹配');
    }

    // 22d) ID 版本号跟 package.json 走（原来硬编码，每次升版都要改补丁）
    s22 = s22.replace(/"version" "[0-9][^"]*"/g, `"version" "${PKG_VERSION}"`);
  }
  if (s22 !== before22) fs.writeFileSync(serverTargetPath, s22, 'utf8');
}

/* ---- 23) APPEND 打开 extensionAdapter 后，COPY/MOVE 必须维持「不支持」（v0.2.20）----
 * Apple Mail 等客户端发信后会把副本 APPEND 到已发送（v0.2.20 已在 adapters.js 提供
 * extensionAdapter.appendMessage 去重应答）。但库一旦看到 extensionAdapter 就会连带启用
 * COPY/MOVE 并调用 copyMessage/moveMessage —— 用户已定「移动不做」，且这两个方法未实现时
 * 抛出的异常会被 processLine 的 .catch 静默吞掉，客户端拿不到 tagged 响应会挂起。
 * 这里用 _copyMove 开关把 COPY/MOVE 挡回 NO（原来的 "not supported" 原样保留）。 */
{
  const serverTarget = path.join(serverDist, 'index.js');
  let s23 = fs.readFileSync(serverTarget, 'utf8');
  const before23 = s23;
  let matched23 = 0;
  for (const cmd of ['COPY', 'MOVE']) {
    const anchor = '        if (!adapters.extensionAdapter) {\n'
      + `          return { lines: [formatTagged(tag, "NO", "${cmd} not supported")], disconnect: false };\n`
      + '        }';
    const patched = '        if (!adapters.extensionAdapter || adapters.extensionAdapter._copyMove !== true) {\n'
      + `          return { lines: [formatTagged(tag, "NO", "${cmd} not supported")], disconnect: false };\n`
      + '        }';
    if (s23.includes(patched)) { matched23++; continue; }
    if (s23.includes(anchor)) {
      s23 = s23.replace(anchor, patched);
      matched23++;
    } else {
      console.warn(`[patch] ${cmd} 分支锚点未匹配，需人工检查`);
    }
  }
  if (matched23 === 2) applied++;
  if (s23 !== before23) fs.writeFileSync(serverTarget, s23, 'utf8');
  console.log(`[patch] 23) COPY/MOVE 开关：${matched23}/2 处生效`);
}

/* ---- 24) STORE \Deleted 必须转成站内软删除（v0.2.21）----
 * 现象：Mac「已发送」里删邮件，删掉后自己又回来（其它文件夹不明显，因为已发送没有
 * 「移到废纸篓」的路径可退）。根因：handleStore 只回写 isRead / isStarred，
 * \Deleted 完全没落到 adapter —— 邮件在库里原封不动，客户端本地移除后一刷新又出现。
 * 修法：把 \Deleted 映射到 updateMessageFlags 的 deletedAt（adapters.js 里已实现
 * deletedAt=true → deleteEmails 软删除进回收站）。 */
{
  const before24 = fs.readFileSync(target, 'utf8');
  let s24 = before24;
  if (s24.includes('[S37-deleted]')) {
    console.log('[patch] STORE \\Deleted 已是补丁版，跳过');
  } else {
    const anchor = [
      '    fields.isRead = newFlags.includes("\\\\Seen");',
      '    fields.isStarred = newFlags.includes("\\\\Flagged");',
    ].join('\n');
    if (s24.includes(anchor)) {
      s24 = s24.replace(anchor, anchor + '\n'
        + '    // [S37-deleted] \\Deleted 没有中间态：直接转成站内软删除（进回收站），\n'
        + '    // 否则客户端删本地、刷新后又回来（「删除自动恢复」）\n'
        + '    fields.deletedAt = newFlags.includes("\\\\Deleted");');
      applied += 1;
      console.log('[patch] 已应用 STORE \\Deleted → 软删除');
    } else {
      console.warn('[patch] handleStore 回写锚点未匹配，需人工检查');
    }
  }
  if (s24 !== before24) fs.writeFileSync(target, s24, 'utf8');
}

/* ---- 25) COPY/MOVE 目标校验：只放行回收站（v0.2.22）----
 * Apple Mail 删除邮件 = UID COPY Trash → STORE \Deleted → EXPUNGE；此前 copyMessage/
 * moveMessage 未实现，adapter 抛的异常在 handleCopy/handleMove 里只变成
 * "* BAD Internal server error"（无 tagged 响应，客户端挂起/只删本地）。
 * 修法：拿到 targetFolderId 后先让 extensionAdapter.assertCopyTarget 校验目标，
 * 非回收站直接回干净的 tagged NO（复制/移动到其他文件夹仍不做，用户已定）。 */
{
  const chunkTarget = path.join(here, '..', 'node_modules', '@rafters', 'mail-imap', 'dist', 'chunk-BPERTDQI.js');
  if (!fs.existsSync(chunkTarget)) {
    console.warn('[patch] 未找到 mail-imap/dist/chunk-BPERTDQI.js，跳过 COPY/MOVE 目标校验');
  } else {
    const before25 = fs.readFileSync(chunkTarget, 'utf8');
    let s25 = before25;
    if (s25.includes('[S37-copytarget]')) {
      console.log('[patch] COPY/MOVE 目标校验已是补丁版，跳过');
    } else {
      const anchor25 = '  const targetFolderId = await adapter.getFolderIdByName(mailboxId, parsed.targetMailbox);';
      const repl25 = anchor25 + '\n' + [
        '  // [S37-copytarget] 只放行回收站（站内软删除语义）；抛异常只会变 BAD 且无 tagged 响应，',
        '  // 必须在这里拦下回 tagged NO',
        '  if (typeof adapter.assertCopyTarget === "function") {',
        '    const targetErr = adapter.assertCopyTarget(targetFolderId);',
        '    if (targetErr) return [formatTagged(tag, "NO", targetErr)];',
        '  }',
      ].join('\n');
      const hits = s25.split(anchor25).length - 1;
      if (hits === 2) {
        s25 = s25.split(anchor25).join(repl25);
        fs.writeFileSync(chunkTarget, s25, 'utf8');
        applied += 1;
        console.log('[patch] 已应用 COPY/MOVE 目标校验（仅回收站）×2');
      } else {
        console.warn(`[patch] handleCopy/handleMove 锚点命中 ${hits}/2 处，需人工检查`);
      }
    }
  }
}

/* ---- 26) COPY/MOVE 执行期异常 → tagged NO（v0.2.23）----
 * 补丁 25 只拦住「目标文件夹不合法」这一种。执行中还会失败：例如「移至垃圾邮件」但该封
 * 是已发送（站内 spam 只对收件箱成立）、或站点接口返回 count=0。此前 adapter 抛错会被
 * 上层吞成 "* BAD Internal server error"（无 tagged 响应，客户端只好把信留在本地）。
 * 修法：在 chunk 里直接包一层 try/catch，e.imapNo 有值就用它当 NO 文案。 */
{
  const chunkTarget2 = path.join(here, '..', 'node_modules', '@rafters', 'mail-imap', 'dist', 'chunk-BPERTDQI.js');
  if (!fs.existsSync(chunkTarget2)) {
    console.warn('[patch] 未找到 mail-imap/dist/chunk-BPERTDQI.js，跳过 COPY/MOVE 异常兜底');
  } else {
    const before26 = fs.readFileSync(chunkTarget2, 'utf8');
    let s26 = before26;
    if (s26.includes('[S37-copyerr]')) {
      console.log('[patch] COPY/MOVE 异常兜底已是补丁版，跳过');
    } else {
      const anchors26 = [
        '    const result = await adapter.copyMessage(msgId, targetFolderId);',
        '    const result = await adapter.moveMessage(msgId, targetFolderId);',
      ];
      let hit26 = 0;
      for (const anchor of anchors26) {
        if (!s26.includes(anchor)) continue;
        const method = anchor.includes('copyMessage') ? 'copyMessage' : 'moveMessage';
        s26 = s26.replace(anchor, [
          '    // [S37-copyerr] adapter 抛错（目标不支持 / 站点拒绝）→ 回 tagged NO，别让上层变 BAD',
          '    let result;',
          '    try {',
          `      result = await adapter.${method}(msgId, targetFolderId);`,
          '    } catch (e) {',
          '      return [formatTagged(tag, "NO", (e && e.imapNo) || "COPY/MOVE failed")];',
          '    }',
        ].join('\n'));
        hit26 += 1;
      }
      if (hit26 === 2) {
        fs.writeFileSync(chunkTarget2, s26, 'utf8');
        applied += 1;
        console.log('[patch] 已应用 COPY/MOVE 异常兜底 → tagged NO ×2');
      } else {
        console.warn(`[patch] COPY/MOVE 执行锚点命中 ${hit26}/2 处，需人工检查`);
      }
    }
  }
}

/* ---- 27) EXPUNGE 应答改用「会话级已删 uid」（v0.2.26）----
 * 背景：v0.2.25 曾把站内 is_del=1 映射成 message.deletedAt → 客户端 FLAGS 里带 \Deleted，
 * 结果 Apple Mail 把整个废纸篓当「已删除待清除」隐藏（显示 0 封，网页端 57 封）。
 * 正确做法：回收站里的信不带 \Deleted；STORE \Deleted 时在 session 上记下 uid，
 * EXPUNGE / UID EXPUNGE 就按这份记录回 * n EXPUNGE（一次会话一个文件夹，天然不会串）。 */
{
  const chunk27 = path.join(here, '..', 'node_modules', '@rafters', 'mail-imap', 'dist', 'chunk-NEG3QHYJ.js');
  const srv27 = path.join(here, '..', 'node_modules', '@rafters', 'mail-imap-server', 'dist', 'index.js');
  if (!fs.existsSync(chunk27) || !fs.existsSync(srv27)) {
    console.warn('[patch] 未找到 EXPUNGE 相关文件，跳过会话级已删记录');
  } else {
    let c27 = fs.readFileSync(chunk27, 'utf8');
    let v27 = fs.readFileSync(srv27, 'utf8');
    const cBefore = c27;
    const vBefore = v27;
    if (c27.includes('[S37-expungeset]') && v27.includes('[S37-expungeset-uid]')) {
      console.log('[patch] 会话级 EXPUNGE 已是补丁版，跳过');
    } else {
      // (a) STORE \Deleted 时把 uid 记到 session
      const storeAnchor = '    fields.deletedAt = newFlags.includes("\\\\Deleted");';
      if (c27.includes(storeAnchor) && !c27.includes('[S37-expungeset]')) {
        c27 = c27.replace(storeAnchor, storeAnchor + '\n'
          + '    // [S37-expungeset] 记下本会话刚被标删的 uid：EXPUNGE 靠它回答 * n EXPUNGE，\n'
          + '    // 而不是靠 message.deletedAt（回收站的信带 \\Deleted 会被客户端整箱隐藏）\n'
          + '    if (fields.deletedAt) {\n'
          + '      if (!session.__s37Del) session.__s37Del = new Set();\n'
          + '      session.__s37Del.add(uid);\n'
          + '    }');
      }
      // (b) 普通 EXPUNGE 判定加会话记录
      const expAnchor = '    if (message === void 0 || message.deletedAt !== null) {';
      if (c27.includes(expAnchor)) {
        c27 = c27.replace(expAnchor, '    if (message === void 0 || message.deletedAt !== null\n'
          + '      || (session.__s37Del && session.__s37Del.has(uid))) { // [S37-expungeset]');
      }
      // (c) UID EXPUNGE 判定加会话记录
      const uidAnchor = '                  return (msg === void 0 || msg.deletedAt !== null) ? uid : null;';
      if (v27.includes(uidAnchor) && !v27.includes('[S37-expungeset-uid]')) {
        v27 = v27.replace(uidAnchor, '                  // [S37-expungeset-uid] 会话里刚标删的也算已删\n'
          + '                  return (msg === void 0 || msg.deletedAt !== null\n'
          + '                    || (session.__s37Del && session.__s37Del.has(uid))) ? uid : null;');
      }
      if (c27 !== cBefore) fs.writeFileSync(chunk27, c27, 'utf8');
      if (v27 !== vBefore) fs.writeFileSync(srv27, v27, 'utf8');
      if (c27 !== cBefore || v27 !== vBefore) {
        applied += 1;
        console.log('[patch] 已应用会话级 EXPUNGE 判定（STORE 记录 + EXPUNGE/UID EXPUNGE 应答）');
      } else {
        console.warn('[patch] 会话级 EXPUNGE 锚点未匹配，需人工检查');
      }
    }
  }
}

/* ---- 28) EXPUNGE 按「当前文件夹实时 UID 列表」判定（v0.2.27）----
 * 补丁 27 的会话级记录只在同一会话有效：客户端 STORE \Deleted 后断线重连再 EXPUNGE
 * （Outlook / mutt / 部分手机就这么干）→ 记录没了，又回不出 * n EXPUNGE。
 * 通用做法：拿 session.selectedFolder.folderId 取该文件夹当前 UID 列表，
 * 不在列表里就是「已从本文件夹消失」→ 回 * n EXPUNGE。回收站里的信在列表里，不受影响。
 * 代价：每条 EXPUNGE 一次 list 调用（网关侧 10 秒缓存）。 */
{
  const chunk28 = path.join(here, '..', 'node_modules', '@rafters', 'mail-imap', 'dist', 'chunk-NEG3QHYJ.js');
  const srv28 = path.join(here, '..', 'node_modules', '@rafters', 'mail-imap-server', 'dist', 'index.js');
  if (!fs.existsSync(chunk28) || !fs.existsSync(srv28)) {
    console.warn('[patch] 未找到 EXPUNGE 相关文件，跳过实时 UID 判定');
  } else {
    let c28 = fs.readFileSync(chunk28, 'utf8');
    let v28 = fs.readFileSync(srv28, 'utf8');
    const cB = c28;
    const vB = v28;
    if (c28.includes('[S37-expungelive]')) {
      console.log('[patch] 实时 UID 判定已是补丁版，跳过');
    } else {
      // (a) handleExpunge 增加 mailboxAdapter 参数
      c28 = c28.replace(
        'async function handleExpunge(tag, session, uidMap, adapter) {',
        'async function handleExpunge(tag, session, uidMap, adapter, mailboxAdapter) {',
      );
      // (b) 循环前取一次实时 UID 集合
      c28 = c28.replace(
        '  const responses = [];\n  const toExpunge = [];',
        [
          '  const responses = [];',
          '  const toExpunge = [];',
          '  // [S37-expungelive] 当前文件夹的实时 UID 集合：不在里面 = 已从本文件夹消失',
          '  let liveUids = null;',
          '  const s37FolderId = session.selectedFolder?.folderId;',
          '  if (s37FolderId !== void 0 && mailboxAdapter && typeof mailboxAdapter.getMessageUids === "function") {',
          '    try {',
          '      const rows = await mailboxAdapter.getMessageUids(s37FolderId);',
          '      liveUids = new Set((rows || []).map((r) => Number(r.uid)));',
          '    } catch (e) { /* 取列表失败就退回旧判定，不影响 EXPUNGE 本身 */ }',
          '  }',
        ].join('\n'),
      );
      // (c) 判定加上实时集合
      c28 = c28.replace(
        '    if (message === void 0 || message.deletedAt !== null\n      || (session.__s37Del && session.__s37Del.has(uid))) { // [S37-expungeset]',
        '    if (message === void 0 || message.deletedAt !== null\n'
          + '      || (session.__s37Del && session.__s37Del.has(uid)) // [S37-expungeset]\n'
          + '      || (liveUids !== null && !liveUids.has(Number(uid)))) {',
      );
      // (d) 调用点补 mailboxAdapter
      v28 = v28.replace(
        '(uidMap) => handleExpunge(tag, session, uidMap, adapters.messageAdapter)',
        '(uidMap) => handleExpunge(tag, session, uidMap, adapters.messageAdapter, adapters.mailboxAdapter)',
      );
      // (e) UID EXPUNGE 里也加实时集合（那里能直接拿 state.mailboxId）
      const uidAnchor = '            const targets = [];\n            // 分批并发查详情';
      if (v28.includes(uidAnchor)) {
        v28 = v28.replace(uidAnchor, [
          '            const targets = [];',
          '            // [S37-expungelive] 当前文件夹实时 UID 集合（补丁 28）：断线重连后也能正确回答',
          '            let liveUids = null;',
          '            try {',
          '              const rows28 = await adapters.mailboxAdapter.getMessageUids(state.mailboxId);',
          '              liveUids = new Set((rows28 || []).map((r) => Number(r.uid)));',
          '            } catch (e) { /* 失败退回旧判定 */ }',
          '            // 分批并发查详情',
        ].join('\n'));
      }
      const uidCond = '                  return (msg === void 0 || msg.deletedAt !== null\n'
        + '                    || (session.__s37Del && session.__s37Del.has(uid))) ? uid : null;';
      if (v28.includes(uidCond)) {
        v28 = v28.replace(uidCond, '                  return (msg === void 0 || msg.deletedAt !== null\n'
          + '                    || (session.__s37Del && session.__s37Del.has(uid))\n'
          + '                    || (liveUids !== null && !liveUids.has(Number(uid)))) ? uid : null;');
      }
      if (c28 !== cB) fs.writeFileSync(chunk28, c28, 'utf8');
      if (v28 !== vB) fs.writeFileSync(srv28, v28, 'utf8');
      if (c28 !== cB || v28 !== vB) {
        applied += 1;
        console.log('[patch] 已应用 EXPUNGE 实时 UID 判定（复用会话记录之上，跨会话也成立）');
      } else {
        console.warn('[patch] 实时 UID 判定锚点未匹配，需人工检查');
      }
    }
  }
}

console.log(`[patch] 共应用 ${applied} 组补丁（目标 ≥ 28），IMAP 网关版本 ${PKG_VERSION}`);
