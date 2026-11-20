/**
 * [v0.2.33] 网关心跳上报（配合主程序「网关状态」）
 *
 * 为什么必须上报：站点跑在 Cloudflare Workers，没有原始 TCP，fetch 也不允许
 * 993 / 2465 这类端口，所以站点永远无法主动探测网关，只能等网关说话。
 *
 * 接口：POST ${HB_URL}/api/imap/heartbeat
 *   body : { key, domain, version, certDays, uptime, ts }
 *   成功 : HTTP 200 + { code: 200, message: 'success', data: { serverTime } }
 *   失败 : 密钥错误时 HTTP 状态仍是 200，body 是 { code: 401 }
 *          —— 主程序统一 result 包装，只看 HTTP status 会把失败当成成功，
 *             所以下面必须判 body.code。
 *
 * 原则：心跳是旁路能力。任何失败只打 warn 日志，绝不影响 IMAP / SMTP 服务；
 *       未配置 HB_URL / HB_KEY 时整个模块静默跳过（v0.2.32 升级上来不受影响）。
 *       密钥只出现在请求 body 里，绝不写进日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function readVersion() {
  try {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
    return String(JSON.parse(fs.readFileSync(pkg, 'utf8')).version || '');
  } catch {
    return '';
  }
}

/** 读容器内证书算剩余天数；容器基于 node:20-alpine，不依赖 openssl CLI */
export function certDaysLeft(certPath) {
  try {
    const x = new X509Certificate(fs.readFileSync(certPath, 'utf8'));
    const end = Date.parse(x.validTo);
    if (!Number.isFinite(end)) return -1;
    return Math.max(-1, Math.floor((end - Date.now()) / 86400000));
  } catch {
    return -1;
  }
}

export function heartbeatUrl(base) {
  return `${String(base || '').replace(/\/+$/, '')}/api/imap/heartbeat`;
}

export function buildPayload({
  env = process.env,
  version = readVersion(),
  certPath,
  now = Date.now(),
  uptime = process.uptime()
} = {}) {
  const cert = certPath || path.join(env.CERT_DIR || '/certs', 'fullchain.pem');
  return {
    key: String(env.HB_KEY || ''),
    domain: String(env.HB_DOMAIN || env.DOMAIN || ''),
    version: String(version || ''),
    certDays: certDaysLeft(cert),
    uptime: Math.max(0, Math.floor(uptime)),
    ts: Math.floor(now / 1000)
  };
}

export async function sendHeartbeat({
  env = process.env,
  fetchImpl = globalThis.fetch,
  version,
  certPath,
  now = Date.now(),
  uptime = process.uptime(),
  log = console
} = {}) {
  const payload = buildPayload({ env, version, certPath, now, uptime });
  try {
    const res = await fetchImpl(heartbeatUrl(env.HB_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });
    const body = await res.json().catch(() => null);
    // 关键：业务 401 的 HTTP 状态仍是 200，body.code 才是真结果
    if (res.status === 200 && body && Number(body.code) === 200) {
      log.log?.(`[hb] 上报成功${body?.data?.serverTime ? ` serverTime=${body.data.serverTime}` : ''}`);
      return { ok: true, payload };
    }
    const why = `HTTP ${res.status} / body.code=${body && body.code !== undefined ? body.code : '无'}`;
    log.warn?.(`[hb] 上报失败：${why}（密钥错误或站点未就绪，不影响邮件服务）`);
    return { ok: false, reason: why, payload };
  } catch (e) {
    const why = String(e?.message || e?.name || e);
    log.warn?.(`[hb] 上报异常：${why}（不影响邮件服务）`);
    return { ok: false, reason: why, payload };
  }
}

export function startHeartbeat(opts = {}) {
  const env = opts.env || process.env;
  const url = String(env.HB_URL || '').trim();
  const key = String(env.HB_KEY || '').trim();
  if (!url || !key) {
    console.log('[hb] 未配置 HB_URL / HB_KEY，心跳上报已跳过');
    return null;
  }
  const raw = Number(env.HB_INTERVAL_MS);
  const intervalMs = Number.isFinite(raw) && raw >= MIN_INTERVAL_MS
    ? Math.min(raw, MAX_INTERVAL_MS)
    : DEFAULT_INTERVAL_MS;

  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await sendHeartbeat({ ...opts, env });
    } finally {
      inFlight = false;
    }
  };

  void tick();                       // 启动即上报一次，装完立刻能看到「在线」
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();                   // 不阻止进程退出
  console.log(`[hb] 心跳已启动：每 ${Math.round(intervalMs / 60000)} 分钟上报一次 → ${heartbeatUrl(url)}`);
  return { stop() { clearInterval(timer); } };
}
