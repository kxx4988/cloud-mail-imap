// [S37] cloud-mail Worker API 客户端：token 缓存、超时、错误归一
// 所有请求头 Authorization 不带 Bearer 前缀（cloud-mail 约定）

const WORKER_BASE = (process.env.WORKER_BASE || '').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = Number(process.env.WORKER_TIMEOUT_MS || 20000);

// email -> { token, accountId, expiresAt, password }
const sessions = new Map();

// [S37] 短期缓存：客户端打开一个文件夹会对同一封邮件反复 FETCH（结构 → 正文 → 分段），
// 每次回源都是跨境 HTTP，串行下来 15 封要 6 秒以上（Mail 左下角「正在下载邮件 7/15」）。
// 详情 60 秒 / 200 条 LRU；列表 10 秒；标记已读/星标/删除时主动失效，避免客户端读到陈旧状态。
const DETAIL_TTL_MS = Number(process.env.DETAIL_CACHE_TTL_MS || 60000);
const DETAIL_CACHE_MAX = Number(process.env.DETAIL_CACHE_MAX || 200);
const LIST_TTL_MS = Number(process.env.LIST_CACHE_TTL_MS || 10000);
const LIST_CACHE_MAX = Number(process.env.LIST_CACHE_MAX || 60);

const detailCache = new Map();   // `${email}:${emailId}` -> { at, value }
const detailInflight = new Map(); // 同一封并发请求合并成一次
const listCache = new Map();      // `${email}|${slug}|${epoch}` -> { at, value }
const listEpoch = new Map();      // email -> number（标记变更后自增，令旧列表缓存失配）

function cacheGet(map, key, ttl) {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttl) {
    map.delete(key);
    return undefined;
  }
  map.delete(key); // LRU：命中后移到末尾
  map.set(key, hit);
  return hit.value;
}

function cacheSet(map, key, value, max) {
  map.delete(key);
  map.set(key, { at: Date.now(), value });
  while (map.size > max) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function invalidateDetail(email, emailId) {
  detailCache.delete(`${String(email).toLowerCase()}:${emailId}`);
}

function bumpListEpoch(email) {
  const k = String(email).toLowerCase();
  listEpoch.set(k, (listEpoch.get(k) || 0) + 1);
}

function invalidateEmail(email, emailId) {
  invalidateDetail(email, emailId);
  bumpListEpoch(email);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

async function request(path, { method = 'GET', body = null, query = null, token = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const url = new URL(WORKER_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = token;
  if (body !== null) headers['content-type'] = 'application/json';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    if (json && json.code !== undefined && json.code !== 200) {
      const err = new Error(`API ${json.code} ${path}: ${json.message || ''}`);
      err.status = json.code;
      throw err;
    }
    return json ? json.data : null;
  } finally {
    clearTimeout(timer);
  }
}

async function login(email, appPassword) {
  const data = await request('/api/imap/auth', {
    method: 'POST',
    body: { email, password: appPassword },
  });
  if (!data || !data.token) {
    throw new Error('imap auth: no token in response');
  }
  sessions.set(String(email).toLowerCase(), {
    token: data.token,
    accountId: data.accountId,
    // 提前 60 秒过期，防止边界失效
    expiresAt: nowSec() + (data.expiresIn || 3600) - 60,
    password: appPassword,
  });
  return sessions.get(String(email).toLowerCase());
}

async function getSession(email, appPassword, { force = false } = {}) {
  const key = String(email).toLowerCase();
  let s = sessions.get(key);
  if (!s || force || nowSec() >= s.expiresAt) {
    s = await login(email, appPassword);
  }
  return s;
}

// 带会话的请求：401/授权失败时强制重登一次
async function authedRequest(email, appPassword, path, opts = {}) {
  const s = await getSession(email, appPassword);
  try {
    return await request(path, { ...opts, token: s.token });
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      const s2 = await getSession(email, appPassword, { force: true });
      return await request(path, { ...opts, token: s2.token });
    }
    throw e;
  }
}

function getAccountId(email) {
  const s = sessions.get(String(email).toLowerCase());
  return s ? s.accountId : null;
}

// ---------- 业务封装 ----------

// slug 必须用库 SYSTEM_FOLDER_FLAGS 认的小写键（inbox/sent/trash/spam），
// 否则 LIST 不带 \Sent \Trash \Junk，客户端只当普通文件夹（显示英文名、删除不进废纸篓）
const FOLDER_PARAMS = {
  inbox: { type: 0 },
  sent: { type: 1 },
  trash: { deleted: 1 },
  spam: { spam: 1 },
};

const FOLDERS = [
  { id: 'inbox', name: 'INBOX', slug: 'inbox', isSystem: true, hasChildren: false },
  { id: 'sent', name: 'Sent', slug: 'sent', isSystem: true, hasChildren: false },
  { id: 'trash', name: 'Trash', slug: 'trash', isSystem: true, hasChildren: false },
  { id: 'spam', name: 'Junk', slug: 'spam', isSystem: true, hasChildren: false },
];

// 列邮件：size 上限 50/页，游标 emailId 翻页；最多拉 MAX_PAGES 页
const PAGE_SIZE = 50;
const MAX_PAGES = 5;

async function listEmails(email, appPassword, folderSlug) {
  const s = await getSession(email, appPassword);
  const params = FOLDER_PARAMS[folderSlug];
  if (!params) return [];
  const ek = String(email).toLowerCase();
  const ck = `${ek}|${folderSlug}|${listEpoch.get(ek) || 0}`;
  const cached = cacheGet(listCache, ck, LIST_TTL_MS);
  if (cached !== undefined) return cached;
  const all = [];
  let cursor = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await authedRequest(email, appPassword, '/api/email/list', {
      query: { accountId: s.accountId, size: PAGE_SIZE, full: 0, emailId: cursor || undefined, ...params },
    });
    const list = (data && data.list) || [];
    all.push(...list);
    if (list.length < PAGE_SIZE) break;
    cursor = list[list.length - 1].emailId;
  }
  cacheSet(listCache, ck, all, LIST_CACHE_MAX);
  return all;
}

// [S37] deleted:1 必带：官方 detail 默认只查 is_del=NORMAL，回收站邮件否则一律 404「邮件不存在」，
// 网关侧表现为 Trash 列表有信但 FETCH 全空（客户端点开空白）。归属校验仍在 userId，非本人照样 404。
async function getDetail(email, appPassword, emailId) {
  const key = `${String(email).toLowerCase()}:${emailId}`;
  const cached = cacheGet(detailCache, key, DETAIL_TTL_MS);
  if (cached !== undefined) return cached;
  const running = detailInflight.get(key);
  if (running) return running;
  const task = (async () => {
    const data = await authedRequest(email, appPassword, '/api/email/detail', {
      query: { emailId, deleted: 1 },
    });
    if (data) cacheSet(detailCache, key, data, DETAIL_CACHE_MAX);
    return data;
  })();
  detailInflight.set(key, task);
  try {
    return await task;
  } finally {
    detailInflight.delete(key);
  }
}

async function markRead(email, appPassword, emailId, read) {
  const r = await authedRequest(email, appPassword, '/api/email/read', {
    method: 'PUT',
    body: { emailIds: [emailId], unread: read ? 1 : 0 },
  });
  invalidateEmail(email, emailId);
  return r;
}

async function setStar(email, appPassword, emailId, starred) {
  const r = starred
    ? await authedRequest(email, appPassword, '/api/star/add', { method: 'POST', body: { emailId } })
    : await authedRequest(email, appPassword, '/api/star/cancel', { method: 'DELETE', query: { emailId } });
  invalidateEmail(email, emailId);
  invalidateStarCache(email); // 星标集合缓存必须一起失效，否则下一封 FETCH 还是旧状态
  return r;
}

async function deleteEmails(email, appPassword, emailIds) {
  const r = await authedRequest(email, appPassword, '/api/email/delete', {
    method: 'DELETE',
    query: { emailIds: emailIds.join(',') },
  });
  for (const id of emailIds) invalidateEmail(email, id);
  return r;
}

// [v0.2.25] 标记/取消垃圾邮件：站内 spam 字段（只对 type=0 收件生效，服务端自己会过滤）
async function markSpam(email, appPassword, emailIds, spam = 1) {
  const r = await authedRequest(email, appPassword, '/api/email/spam', {
    method: 'POST',
    body: { emailIds: emailIds.join(','), spam },
  });
  for (const id of emailIds) invalidateEmail(email, id);
  return r;
}

// [v0.2.25] 星标集合：/api/email/detail 不返回 isStar / starId（那是 list / star/list 才 join 的），
// 所以 FETCH FLAGS 想报 \Flagged 只能反查一次 /api/star/list。集合很小，缓存 30 秒。
const starCache = new Map(); // email -> { at, set }
const STAR_TTL_MS = Number(process.env.STAR_CACHE_TTL_MS || 30000);

async function listStarredIds(email, appPassword) {
  const key = String(email).toLowerCase();
  const hit = starCache.get(key);
  if (hit && Date.now() - hit.at < STAR_TTL_MS) return hit.set;
  const set = new Set();
  let cursor = 0;
  for (let page = 0; page < 10; page++) {
    const data = await authedRequest(email, appPassword, '/api/star/list', {
      query: { size: 50, full: 0, emailId: cursor || undefined },
    });
    const list = (data && data.list) || [];
    for (const e of list) set.add(Number(e.emailId));
    if (list.length < 50) break;
    cursor = list[list.length - 1].emailId;
  }
  starCache.set(key, { at: Date.now(), set });
  return set;
}

function invalidateStarCache(email) {
  starCache.delete(String(email).toLowerCase());
}

async function fetchAtt(email, appPassword, key) {
  const url = WORKER_BASE + '/api/oss/' + key;
  const s = await getSession(email, appPassword);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { authorization: s.token }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`att download HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  } finally {
    clearTimeout(timer);
  }
}

export {
  WORKER_BASE,
  sessions,
  login,
  getSession,
  authedRequest,
  getAccountId,
  listEmails,
  getDetail,
  markRead,
  setStar,
  deleteEmails,
  markSpam,
  listStarredIds,
  fetchAtt,
  FOLDERS,
  FOLDER_PARAMS,
};
