// [S37] @rafters/mail-imap 适配器：把 IMAP 命令翻译成 cloud-mail API 调用
//
// 会话上下文方案：库的 adapter 接口不携带 session，因此把邮箱编进所有 ID：
//   mailboxId  = email（resolveMailboxId 返回）
//   folderId   = `${slug}:${email}`
//   messageId  = `${emailId}:${email}`
//   blobKey    = `${emailId}:${email}`
// 应用密码由 LOGIN 成功时缓存在 worker-client 的 sessions 里，凭 email 取回。

import {
  login,
  listEmails,
  getDetail,
  markRead,
  setStar,
  deleteEmails,
  markSpam,
  listStarredIds,
  fetchAtt,
  sessions,
  FOLDERS,
} from './worker-client.js';
import { buildRfc822, computeMeta, safeDate, encodeHeader, parseRecipientList } from './mime.js';
import { extractSection } from './sections.js';

// UIDVALIDITY 固定 1：UID 用 email_id（全局单调递增）
const UID_VALIDITY = 1;

// [v0.2.23] 带 imapNo 的错误：补丁 26 会把它转成 tagged NO（而非 "* BAD Internal server error"），
// 客户端能显示原因、也不会再出现「本地删了服务器没动」的静默失败
function imapNo(message) {
  const e = new Error(message);
  e.imapNo = message;
  return e;
}

// [S37] 批量取信并发数：原来串行 for 循环，15 封 = 15 次跨境 HTTP（实测 6.7 秒）。
const DETAIL_CONCURRENCY = Math.max(1, Number(process.env.DETAIL_CONCURRENCY || 6));

// [S37] 原文缓存：客户端取正文的固定套路是 BODYSTRUCTURE → BODY[] / BODY[TEXT] / BODY[n]，
// 每取一次都要重建整封并重新下载附件（buildRfc822 会回源 OSS）。缓存 60 秒，超大邮件不缓存。
const RAW_TTL_MS = Number(process.env.RAW_CACHE_TTL_MS || 60000);
const RAW_CACHE_MAX = Number(process.env.RAW_CACHE_MAX || 30);
const RAW_CACHE_MAX_BYTES = Number(process.env.RAW_CACHE_MAX_BYTES || 2 * 1024 * 1024);
const rawCache = new Map(); // blobKey -> { at, value }

function rawCacheGet(key) {
  const hit = rawCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > RAW_TTL_MS) {
    rawCache.delete(key);
    return undefined;
  }
  rawCache.delete(key);
  rawCache.set(key, hit);
  return hit.value;
}

function rawCacheSet(key, value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > RAW_CACHE_MAX_BYTES) return;
  rawCache.delete(key);
  rawCache.set(key, { at: Date.now(), value });
  while (rawCache.size > RAW_CACHE_MAX) {
    rawCache.delete(rawCache.keys().next().value);
  }
}

// 并发受限的 map：保持输出顺序，单个失败不影响其它
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function splitId(idWithMailbox) {
  const str = String(idWithMailbox);
  const idx = str.lastIndexOf(':');
  if (idx === -1) return [str, ''];
  return [str.slice(0, idx), str.slice(idx + 1)];
}

function cachedPassword(email) {
  const s = sessions.get(String(email).toLowerCase());
  return s ? s.password : '';
}

// ---------- AuthAdapter ----------

export const authAdapter = {
  async verifyAppPassword(email, appPassword) {
    try {
      await login(email, appPassword);
      return true;
    } catch (e) {
      console.log(`imap auth fail: ${email} ${e.message}`);
      return false;
    }
  },
};

// ---------- MailboxAdapter ----------

function withMailbox(mailboxId, folders) {
  return folders.map(f => ({ ...f, id: `${f.slug}:${mailboxId}` }));
}

export const mailboxAdapter = {
  async listFolders(mailboxId) {
    return withMailbox(mailboxId, FOLDERS);
  },

  async getFolderByName(mailboxId, name) {
    const wanted = String(name || '').toUpperCase();
    // slug 已改为库认的小写键（spam 对应显示名 Junk），所以 name 也要参与匹配
    const found = FOLDERS.find(f =>
      f.name.toUpperCase() === wanted || f.slug.toUpperCase() === wanted || f.id.toUpperCase() === wanted);
    return found ? { ...found, id: `${found.slug}:${mailboxId}` } : undefined;
  },

  async getFolderStats(folderId) {
    const [slug, email] = splitId(folderId);
    const list = await listEmails(email, cachedPassword(email), slug);
    const unseen = list.filter(e => Number(e.unread) === 0).length; // unread=0 为未读
    const uidNext = list.reduce((m, e) => Math.max(m, Number(e.emailId) || 0), 0) + 1;
    return {
      messages: list.length,
      recent: 0,
      unseen,
      uidValidity: UID_VALIDITY,
      uidNext,
      // [v0.2.14] 只声明真正支持的标志。库默认给 `\Answered \Draft ... \*`，
      // 而站内根本没有「已回复/草稿」状态、也不接受自定义关键字 —— STORE 会静默丢弃，
      // 客户端却以为打标签成功（标了「已答复」再刷新就没了）。
      flags: ['\\Seen', '\\Flagged', '\\Deleted'],
      permanentFlags: ['\\Seen', '\\Flagged', '\\Deleted'],
    };
  },

  async getMessageUids(folderId) {
    const [slug, email] = splitId(folderId);
    const list = await listEmails(email, cachedPassword(email), slug);
    // 必须按 UID 升序返回：库的 UidMap 依赖升序（resolveUidSet 遇 uid > hi 即 break，
    // 降序会让 `1:*` 首项就触发 break → FETCH 返回空，客户端正文/详情全白）
    return list
      .map(e => ({ uid: Number(e.emailId), messageId: `${e.emailId}:${email}` }))
      .sort((a, b) => a.uid - b.uid);
  },
};

// ---------- MessageAdapter ----------

function parseCc(jsonStr) {
  try {
    const arr = JSON.parse(jsonStr || '[]');
    if (!Array.isArray(arr)) return null;
    return arr.map(a => a.address).filter(Boolean);
  } catch (e) {
    return null;
  }
}

// [v0.2.9] 统一走 mime.js 的容错解析：非法/缺失 createTime 不再产生 Invalid Date
function toDate(v) {
  return safeDate(v, new Date(0));
}

// [v0.2.17] 已发送邮件站内只有 recipient（JSON 数组），to_email / to_name 恒为空字符串，
// 库的 buildEnvelope 用 toEmail 拼 ENVELOPE → To 变成空地址（客户端显示「无收件人」）。
// 仅当 to_email 为空时才从 recipient 取第一个地址兜底；收件箱等正常邮件不受影响。
export function toMessageData(row) {
  const isOutbound = Number(row.type) === 1;
  // sizeBytes / bodyStructure 必须与 buildRfc822 的真实输出严格一致，
  // 否则客户端按 BODYSTRUCTURE 取段会拿到不符内容（macOS 正文空白的根因）
  const meta = computeMeta(row);
  const toAddr = String(row.toEmail || '').trim()
    ? { address: String(row.toEmail), name: row.toName ? String(row.toName) : '' }
    : (parseRecipientList(row.recipient)[0] || null);
  return {
    // id 必须与 UID 表里的 messageId（`emailId:email`）一致，否则 FETCH 匹配不上
    id: `${row.emailId}:${row._imapEmail}`,
    messageId: row.messageId || `<cm-${row.emailId}@cloud-mail>`,
    fromEmail: row.sendEmail || '',
    // [v0.2.14] 显示名 / 主题必须做 RFC 2047 编码：库的 buildEnvelope 把这两个字段
    // 原样放进 ENVELOPE 的 NSTRING（双引号字符串），而 IMAP 协议字符串是 7bit 的——
    // 裸 UTF-8 会让客户端按 ASCII/latin1 解析，中文主题与发件人名字全部变成 mojibake
    // （实测：ENVELOPE 里出现 "æ¨çGoogle Workspace…"，而 BODY[HEADER] 里是正常的
    //  encoded-word，因为 mime.js 的 buildRfc822 早就编过一次）。
    fromName: row.name ? encodeHeader(row.name) : null,
    // [v0.2.17] 见上方 toAddr：已发送邮件用它填 To，否则 ENVELOPE To 为空
    toEmail: toAddr ? toAddr.address : '',
    toName: toAddr && toAddr.name ? encodeHeader(toAddr.name) : null,
    ccEmails: parseCc(row.cc),
    bccEmails: null,
    replyToEmail: null,
    subject: encodeHeader(row.subject || ''),
    snippet: (row.text || '').slice(0, 120) || null,
    blobKeyRaw: `${row.emailId}:${row._imapEmail}`,
    blobKeyHtml: null,
    blobKeyText: null,
    isOutbound,
    isRead: Number(row.unread) === 1,
    // [v0.2.14] 列表行里的星标字段是 isStar / starId，不是 isStarred。
    // 旧代码读 row.isStarred 恒为 undefined → FLAGS 里永远没有 \Flagged，
    // 用户在网页端打的星在客户端完全看不见。
    // [v0.2.25] 详情行走的是 email 主表，根本没有 star 关联（实测 detail 返回里无 isStar/starId），
    // 所以 getMessage 会先反查 /star/list 并把结果塞进 _imapStarred，这里优先用它。
    isStarred: row._imapStarred !== undefined
      ? Boolean(row._imapStarred)
      : (row.isStar !== undefined ? Boolean(Number(row.isStar)) : Boolean(row.starId)),
    // [v0.2.26] 这里必须恒 null：回收站里的信不能带 \Deleted 标志。
    // v0.2.25 曾按 is_del=1 映射成 \DeletedDate，结果 Apple Mail 把整个废纸篓当作
    // 「已删除待清除」全部隐藏（显示 0 封），网页端却还有 57 封 —— 数据没丢，只是被客户端藏了。
    // EXPUNGE 的「哪些已删」改由会话级记录（补丁 27：STORE \Deleted 时记 uid）判定。
    deletedAt: null,
    sizeBytes: meta.sizeBytes,
    bodyStructure: meta.bodyStructure,
    receivedAt: toDate(row.createTime),
    sentAt: isOutbound ? toDate(row.createTime) : null,
    inReplyTo: row.inReplyTo || null,
    threadId: String(row.relation || row.emailId),
    folderSlug: row._imapFolder || undefined,
    threadHasOutboundReply: false,
    labelNames: undefined,
  };
}

// [v0.2.9] 主程序记录的附件 size 为 0 / 非法时，真实字节数只能下载后才准；
// BODYSTRUCTURE 与 RFC822.SIZE 全靠它，报 0 会让客户端按 0 字节取段 → 附件坏、后面段落全错位。
// 只在 size 不可信时付这次下载代价，常规邮件零额外请求。
async function fillAttSizes(email, pwd, detail) {
  const atts = Array.isArray(detail.attList) ? detail.attList : [];
  const need = atts.filter(a => a && a.key && !(Number(a.size) > 0));
  if (!need.length) return detail;
  await Promise.all(need.map(async (a) => {
    try {
      const buf = await fetchAtt(email, pwd, a.key);
      detail._attSizes = detail._attSizes || {};
      detail._attSizes[a.key] = buf.length;
    } catch (e) {
      console.log(`att size probe ${a.key} fail: ${e.message}`);
    }
  }));
  return detail;
}

// ---------- SEARCH 条件求值 ----------
// [v0.2.14] 库能解析出 all / new / flag / header / date / size / text / uid / not / or / sequence，
// 旧实现只认 flag / header / text / subject / from / to / unseen / seen —— 其余全部落空后
// `continue` 等于「不过滤」：实测 SINCE 1-Jan-2027、BEFORE 1-Jan-2020、LARGER 60000、
// SMALLER 700、OR、ANSWERED、DELETED 全部返回 16 封（等于没有筛选）。
// 现在逐项求值：不认识的类型返回 false 并记日志，宁可空结果，也不静默放行。

const IMAP_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// IMAP 日期形如 1-Jan-2026 / 01-Jan-2026（RFC 3501 §9），按 UTC 日边界解释
function parseImapDate(str) {
  const m = String(str || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mon = IMAP_MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return null;
  const d = new Date(Date.UTC(Number(m[3]), mon, Number(m[1])));
  return isNaN(d.getTime()) ? null : d;
}

const DAY_MS = 86400000;

function emailTime(e) {
  const d = safeDate(e.createTime, null);
  return d ? d.getTime() : null;
}

function inUidSet(set, uid) {
  for (const r of set || []) {
    if (!r) continue;
    const lo = Number(r.start);
    const hi = r.end === undefined || r.end === null ? lo : Number(r.end);
    if (!isFinite(lo) || !isFinite(hi)) continue;
    const a = Math.min(lo, hi);
    const b = Math.max(lo, hi);
    if (uid >= a && uid <= b) return true;
  }
  return false;
}

function ccHaystack(e) {
  try {
    const arr = JSON.parse(e.cc || '[]');
    if (!Array.isArray(arr)) return '';
    return arr.map(x => `${x.address || ''} ${x.name || ''}`).join(' ').toLowerCase();
  } catch (err) {
    return '';
  }
}

export function matchCriterion(crit, e) {
  if (!crit || !crit.type) return true;
  switch (crit.type) {
    case 'all':
      return true;
    case 'new':
      // RFC 3501：NEW = RECENT + UNSEEN。本站 STATUS RECENT 恒为 0，
      // 所以这里必须为空 —— 否则和 STATUS 自相矛盾。
      return false;
    case 'flag': {
      const neg = !!crit.negated;
      let has;
      if (crit.flag === '\\Seen') has = Number(e.unread) === 1;
      else if (crit.flag === '\\Flagged') has = e.isStar !== undefined ? Number(e.isStar) === 1 : Boolean(e.isStarred || e.starId);
      else has = false; // \Answered / \Draft / \Recent / \Deleted：站内没有这些状态
      return has !== neg;
    }
    case 'uid':
    case 'sequence':
      return inUidSet(crit.set, Number(e.emailId));
    case 'not':
      return !matchCriterion(crit.criterion, e);
    case 'or':
      return matchCriterion(crit.left, e) || matchCriterion(crit.right, e);
    case 'date': {
      const d = parseImapDate(crit.date);
      const t = emailTime(e);
      if (d === null || t === null) return false;
      if (crit.comparison === 'before') return t < d.getTime();
      if (crit.comparison === 'on') return Math.floor(t / DAY_MS) === Math.floor(d.getTime() / DAY_MS);
      return t >= d.getTime(); // since
    }
    case 'size': {
      // 列表行没有 size 字段（实测字段集：emailId/sendEmail/name/subject/code/recipient/
      // toEmail/type/status/message/unread/createTime/isDel/spam/spamTime/top/text/starId/isStar），
      // 所以 searchMessages 会在含 size 条件时预取详情算出 sizeBytes（与 RFC822.SIZE 同源）。
      const n = Number(crit.size) || 0;
      const sz = Number(e.sizeBytes ?? e.size ?? 0) || 0;
      return crit.comparison === 'larger' ? sz > n : sz < n;
    }
    case 'header': {
      const field = String(crit.field || '').toLowerCase();
      const val = String(crit.value || '').toLowerCase();
      if (!val) return true;
      if (field === 'subject') return String(e.subject || '').toLowerCase().includes(val);
      if (field === 'from') return `${e.sendEmail || ''} ${e.name || ''}`.toLowerCase().includes(val);
      // [v0.2.17] 已发送邮件 to_email 为空，按 To 搜索必须把 recipient 里的地址一起算
      if (field === 'to') {
        const hay = [String(e.toEmail || ''), ...parseRecipientList(e.recipient).map(a => a.address)]
          .join(' ').toLowerCase();
        return hay.includes(val);
      }
      if (field === 'cc') return ccHaystack(e).includes(val);
      if (field === 'bcc') return false;
      return false;
    }
    case 'text':
    case 'body': {
      const v = String(crit.value || '').toLowerCase();
      if (!v) return true;
      // body 严格说只搜正文，列表里没有正文全文，用 text 字段（正文纯文本）近似；
      // text 另外带上头字段。两者差异对本场景无实质影响。
      // [v0.2.17] 收件人地址同样并入全文检索（已发送邮件的 to_email 是空的）
      const toHay = [String(e.toEmail || ''), ...parseRecipientList(e.recipient).map(a => a.address)].join(' ');
      const hay = `${e.subject || ''} ${e.sendEmail || ''} ${toHay} ${e.text || ''}`.toLowerCase();
      return hay.includes(v);
    }
    default:
      console.warn(`[imap] unsupported search criterion: ${crit.type}`);
      return false;
  }
}

// 递归判断条件树里是否含 size（or/not 要往下钻）
function hasSizeCriterion(crit) {
  if (!crit) return false;
  if (crit.type === 'size') return true;
  if (crit.type === 'or') return hasSizeCriterion(crit.left) || hasSizeCriterion(crit.right);
  if (crit.type === 'not') return hasSizeCriterion(crit.criterion);
  return false;
}

export const messageAdapter = {
  async getMessage(messageId) {
    const [emailIdStr, email] = splitId(messageId);
    const detail = await getDetail(email, cachedPassword(email), emailIdStr);
    if (!detail) return undefined;
    detail._imapEmail = email;
    // [v0.2.25] 详情接口不含 isStar/starId → 必须反查 /star/list，否则 FLAGS 里永远没有 \Flagged
    try {
      detail._imapStarred = (await listStarredIds(email, cachedPassword(email))).has(Number(emailIdStr));
    } catch (e) {
      // 星标查询失败不影响取信，退回详情里的字段（通常为空）
    }
    await fillAttSizes(email, cachedPassword(email), detail);
    return toMessageData(detail);
  },

  async getMessagesByIds(messageIds) {
    const ids = Array.isArray(messageIds) ? messageIds : [];
    if (!ids.length) return [];
    const results = await mapLimit(ids, DETAIL_CONCURRENCY, async (mid) => {
      try {
        return await this.getMessage(mid);
      } catch (e) {
        console.log(`getMessagesByIds ${mid} fail: ${e.message}`);
        return null;
      }
    });
    return results.filter(Boolean);
  },

  async updateMessageFlags(messageId, fields) {
    const [emailIdStr, email] = splitId(messageId);
    const emailId = Number(emailIdStr);
    const pwd = cachedPassword(email);
    if (fields.isRead !== undefined) {
      await markRead(email, pwd, emailId, !!fields.isRead);
    }
    if (fields.isStarred !== undefined) {
      await setStar(email, pwd, emailId, !!fields.isStarred);
    }
    if (fields.deletedAt) {
      // \Deleted → 站内软删除（进回收站）
      await deleteEmails(email, pwd, [emailId]);
    }
  },

  async deleteMessage(messageId) {
    const [emailIdStr, email] = splitId(messageId);
    await deleteEmails(email, cachedPassword(email), [Number(emailIdStr)]);
  },

  async getBlob(blobKey) {
    const cached = rawCacheGet(blobKey);
    if (cached !== undefined) return cached;
    const [emailIdStr, email] = splitId(blobKey);
    const pwd = cachedPassword(email);
    const detail = await getDetail(email, pwd, emailIdStr);
    const raw = await buildRfc822(email, pwd, detail);
    rawCacheSet(blobKey, raw);
    return raw;
  },

  // 按 IMAP section 精确取段（库默认一律回整封，交给 smtp/imap 两端都会错）
  async getSection(message, section) {
    const key = message && message.blobKeyRaw ? message.blobKeyRaw : '';
    if (!key) return undefined;
    const raw = await this.getBlob(key);
    const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw ?? '');
    return extractSection(text, section);
  },

  async searchMessages(folderId, criteria) {
    const [slug, email] = splitId(folderId);
    const pwd = cachedPassword(email);
    let list = await listEmails(email, pwd, slug);
    const crits = (criteria || []).filter(c => c && c.type);

    // [v0.2.14] 列表接口不返回大小，LARGER/SMALLER 只能回源算。
    // 只在条件里真的出现 size 时才付这个代价（并复用详情缓存），普通搜索零额外请求。
    if (crits.some(hasSizeCriterion) && list.length) {
      const sized = await mapLimit(list, DETAIL_CONCURRENCY, async (e) => {
        try {
          const d = await getDetail(email, pwd, e.emailId);
          return d ? { ...e, sizeBytes: computeMeta(d).sizeBytes } : e;
        } catch (err) {
          return e;
        }
      });
      list = sized;
    }

    const hit = crits.length ? list.filter(e => crits.every(c => matchCriterion(c, e))) : list;
    return hit.map(e => `${e.emailId}:${email}`);
  },
};

/* ------------------------------------------------ ExtensionAdapter（v0.2.20） */

// [v0.2.20] APPEND（RFC 3501 §6.3.6）：Apple Mail / Outlook / Thunderbird 发信后会把副本
// APPEND 到「已发送」，此前网关没有 extensionAdapter，库固定回 "NO APPEND not supported"，
// Apple Mail 每次发信都弹「APPEND not supported」。
// 关键事实：SMTP 链路走 /api/email/send，Worker 端 saveSentEmail() 已经把副本落库，
// 所以这里【不真正写库】，只做去重应答：命中已发送里同一封 → 返回其 emailId 作为 uid；
// 未命中 / 其他文件夹 → 静默 OK（uid 0）。若真写库需要 Worker 新增导入接口，暂不做。
// [v0.2.22] COPY/MOVE 到回收站 = 站内软删除。Apple Mail 删除邮件的流程是
// UID COPY Trash → UID STORE \Deleted → UID EXPUNGE；库的 UID COPY / UID MOVE 分支
// 不受 _copyMove 开关约束（它只挡非 UID 形式），此前 copyMessage/moveMessage 未实现
// → 抛异常回 NO → 客户端认为删除失败只删了本地，网页端永远不变（实测复现）。
// 复制/移动到非回收站文件夹仍不做（用户已定），抛错让库回 NO。

// server 会把 literal 内容压平成一行（换行→空格、"→\\"）再包一层引号喂进来，
// 先剥引号反转义，头字段提取才可靠
function unquoteLiteral(s) {
  let t = String(s || '');
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  return t.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// 从（可能被压平成一行的）RFC822 文本里抽头字段值
function extractHeaderFlat(text, name) {
  const m = new RegExp(`(?:^|[\\r\\n\\s])${name}\\s*:([^\\r\\n]*)`, 'i').exec(text || '');
  return m ? m[1].trim() : '';
}

// 压平后头值后面直接跟下一个头字段（"Subject: x Content-Type: …"），按「单词:」边界截断
function headerValueFlat(text, name) {
  const raw = extractHeaderFlat(text, name);
  return raw.split(/\s+(?=[A-Za-z][A-Za-z0-9-]*:\s)/)[0].trim();
}

// RFC 2047 encoded-word 解码（B / Q），Apple Mail 对中文主题会编码
function decodeMimeWord(s) {
  return String(s || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (all, cs, enc, v) => {
    try {
      if (enc.toLowerCase() === 'b') return Buffer.from(v, 'base64').toString('utf8');
      const bytes = String(v).replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (m2, h) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(bytes, 'binary').toString('utf8');
    } catch (e) {
      return all;
    }
  });
}

// 从地址串（To 头 / recipient JSON）收集全部小写地址
function collectAddresses(s) {
  const m = String(s || '').match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  return [...new Set(m.map(a => a.toLowerCase()))];
}

// 库的 parseAppendArgs 不解析 internalDate（恒 undefined），回退到 content 的 Date 头
function appendRefTime(internalDate, text) {
  if (internalDate instanceof Date && !isNaN(internalDate)) return internalDate;
  const raw = extractHeaderFlat(text, 'Date');
  const dm = /([A-Za-z]{3},\s*)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{1,2}:\d{2}(:\d{2})?\s*([+-]\d{4})?/.exec(raw);
  if (dm) {
    const t = new Date(dm[0].trim());
    if (!isNaN(t)) return t;
  }
  return new Date();
}

// listEmails 的 createTime 是无时区标记的 UTC 字符串，必须按 UTC 解析（按本地时区差 8 小时）
function parseUtc(s) {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

const DUP_WINDOW_MS = 30 * 60 * 1000; // ±30 分钟

// 去重核心（纯函数，verify-append.mjs 直接单测）：
// 判据 = To 地址有交集 && 时间窗内 && （两边 subject 都非空时必须相等）
// 返回命中的 emailId，未命中返回 0
export function findSentDuplicate(list, content, refTime) {
  const text = unquoteLiteral(content);
  const toAddrs = collectAddresses(extractHeaderFlat(text, 'To'));
  if (!toAddrs.length) return 0;
  const subj = decodeMimeWord(headerValueFlat(text, 'Subject')).trim().toLowerCase();
  for (const e of (list || [])) {
    if (!collectAddresses(e.recipient).some(a => toAddrs.includes(a))) continue;
    const t = parseUtc(e.createTime);
    if (t && refTime && Math.abs(t.getTime() - refTime.getTime()) > DUP_WINDOW_MS) continue;
    const es = String(e.subject || '').trim().toLowerCase();
    // literal 压平后头与体之间只剩空格，subject 值可能把正文首段带进来（"发送测试 body"），
    // 所以用前缀互含判定，不用严格相等
    if (subj && es && !(subj === es || subj.startsWith(es) || es.startsWith(subj))) continue;
    return Number(e.emailId) || 0;
  }
  return 0;
}

export const extensionAdapter = {
  // 补丁 23 读这个开关：true 时放行非 UID 的 COPY/MOVE（方法已实现，见下）
  _copyMove: true,

  async getFolderIdByName(mailboxId, name) {
    const wanted = String(name || '').toUpperCase();
    const found = FOLDERS.find(f =>
      f.name.toUpperCase() === wanted || f.slug.toUpperCase() === wanted || f.id.toUpperCase() === wanted);
    return found ? `${found.slug}:${mailboxId}` : undefined;
  },

  // [v0.2.22] 补丁 25 调用：目标不是回收站/垃圾邮件时回错误文案（库转成 tagged NO），
  // 避免在 copyMessage 里抛异常被库吞成 "* BAD Internal server error"
  assertCopyTarget(targetFolderId) {
    const [slug] = splitId(targetFolderId);
    if (slug === 'trash' || slug === 'spam') return null;
    return 'COPY/MOVE not supported (only Trash / Junk)';
  },

  // COPY/MOVE 目标映射（v0.2.22 回收站 / v0.2.23 垃圾邮件）：
  //   回收站 → 站内软删除（deletedAt，进回收站）
  //   垃圾邮件 → 站内 spam=1（离开收件箱，进「垃圾邮件」，与网页端「标记为垃圾」同一效果）
  // 其他目标由 assertCopyTarget 先拦（这里兜底抛 imapNo，补丁 26 会转成 tagged NO）。
  // newUid 回 emailId 本身：站内 UID 恒等于 emailId。
  // MOVE 时库会自动对源文件夹发 EXPUNGE；COPY 时客户端随后会补 STORE \Deleted + EXPUNGE，
  // 重复调 deleteEmails 是幂等的（已删除的邮件再删一次结果不变）。
  async copyMessage(messageId, targetFolderId) {
    const [targetSlug] = splitId(targetFolderId);
    const [emailIdStr, email] = splitId(messageId);
    const emailId = Number(emailIdStr);
    const pwd = cachedPassword(email);
    if (targetSlug === 'trash') {
      await deleteEmails(email, pwd, [emailId]);
      return { uidValidity: UID_VALIDITY, newUid: emailId };
    }
    if (targetSlug === 'spam') {
      // 站内「垃圾邮件」只对收件箱邮件成立（email-service.spam 限定 type=RECEIVE）：
      // 已发送/草稿没有这个语义，必须明确报错，不能静默成功（否则又是一次「删了又回来」）
      const detail = await getDetail(email, pwd, emailId);
      if (!detail || Number(detail.type) !== 0) {
        throw imapNo('移动失败：只有收件箱邮件可以标记为垃圾邮件');
      }
      const r = await markSpam(email, pwd, [emailId], 1);
      if (!r || Number(r.count) === 0) {
        throw imapNo('移动失败：标记垃圾邮件未生效');
      }
      return { uidValidity: UID_VALIDITY, newUid: emailId };
    }
    throw imapNo('COPY/MOVE not supported');
  },

  async moveMessage(messageId, targetFolderId) {
    return this.copyMessage(messageId, targetFolderId);
  },

  async appendMessage(folderId, content, flags, internalDate) {
    const [slug, email] = splitId(folderId);
    try {
      if (slug === 'sent') {
        const pwd = cachedPassword(email);
        const list = await listEmails(email, pwd, 'sent');
        const uid = findSentDuplicate(list, content, appendRefTime(internalDate, unquoteLiteral(content)));
        if (uid) return { uidValidity: UID_VALIDITY, uid };
      }
    } catch (e) {
      // 查重失败不弹窗：静默按未命中处理（副本本来就在 SMTP 链路落库）
      console.log(`append dedup fail (${slug}): ${e.message}`);
    }
    return { uidValidity: UID_VALIDITY, uid: 0 };
  },
};
