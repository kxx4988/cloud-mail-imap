/**
 * [v0.2.33] 网关心跳上报自检（无网络、无 openssl CLI 依赖）
 *
 * 覆盖：
 *   · URL 拼接（尾斜杠）、payload 字段、版本号取自 package.json
 *   · certDaysLeft 用 Node 内置 X509Certificate 读固定测试证书
 *   · 关键回归：主程序业务 401 的 HTTP 状态仍是 200，
 *     只有 body.code 才是真结果 —— 只看 status 会把失败当成功
 *   · 失败（网络异常 / 非 2xx / 非 JSON）只返回 ok:false，绝不抛到外层
 *   · 密钥不进日志
 *   · 未配置 HB_URL / HB_KEY 时 startHeartbeat 静默跳过
 *
 * 用法：node scripts/verify-heartbeat.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readVersion, certDaysLeft, heartbeatUrl, buildPayload,
  sendHeartbeat, startHeartbeat
} from '../src/heartbeat.js';

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name + (extra ? `（${extra}）` : ''));
    console.log(`  ✗ ${name}${extra ? `  ← ${extra}` : ''}`);
  }
}

/* 固定测试证书：自签、到 2043 年，长期有效，避免依赖运行时 openssl */
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIC4TCCAcmgAwIBAgIJAPJJdpBlrb5AMA0GCSqGSIb3DQEBCwUAMB4xHDAaBgNV
BAMME2ltYXAuc2VsZnRlc3QubG9jYWwwHhcNMjYxMTIwMDk1NTE0WhcNNDMwNDI1
MDk1NTE0WjAeMRwwGgYDVQQDDBNpbWFwLnNlbGZ0ZXN0LmxvY2FsMIIBIjANBgkq
hkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyLusTsE0vp0DR89yS7VM60WclPUa/llx
dDtp/slXBelKCczXpqvRnNraMksh1EDpWajOsVPXbpXC+WU34pxC80MFCHTDq4Wi
5UCLCnDDoL0PRP4CUveCMi+I9G5TP4ewdL5OXnxLnvsLUD4ueLz3LZBb4CKK+U72
CMXqryqkKsZLDl5FeaBz/SI5Tm7CtQJeGsx4NZUJyNcv6rl914gcA4EdL07OWruv
ouhCAea0KEgSkk5lql9u5JWC4zBxvi0NVsLf3M0h4MLz/E5BwMxQFLmBcr3LtYf3
kUmg/tby4ctW+h45CnVcK6auYK1Ei/tf2GU0wrQ0IZRZTUdwab3tfwIDAQABoyIw
IDAeBgNVHREEFzAVghNpbWFwLnNlbGZ0ZXN0LmxvY2FsMA0GCSqGSIb3DQEBCwUA
A4IBAQC/gaDV1wlSSW7pwAqr+OOS3oGSaadlq6Fa6SrhuHkn54hbCAVRVqD9JNhF
+/7svadBuBFTQRgYWvJzRl3UHkLF8uf92Q2mjt2euWoEC7Bj9B6CdFQmPWmS7lrL
lwputW0myQmGuVArymsnePMJp85x9uhg8k/34oaaLxYFiqzykjGiPwaOAZrIIn8+
ISU9hthT/+Oq0GftqJ2KoXBCdJCZkkqprQqM5P9fnyuLdSjZLJWoSDBxTLyhaYbL
F0KUCSXZE317x+lWjBZTiJSNwz/OEjPi2DayTnYz5UBm6K7PahV0Xp//fTi398S1
WB51MlBrg71NaF4W5yIlx+SVAMji
-----END CERTIFICATE-----`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-verify-'));
const certFile = path.join(tmp, 'fullchain.pem');
fs.writeFileSync(certFile, TEST_CERT);

const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff';
const BASE_ENV = {
  HB_URL: 'https://mail.example.com',
  HB_KEY: KEY,
  HB_DOMAIN: 'imap.example.com',
  CERT_DIR: tmp
};

function silentLog(sink) {
  return { log: (...a) => sink.push(a.join(' ')), warn: (...a) => sink.push(a.join(' ')) };
}

/* ------------------------------------------------------------ URL / 版本 / 证书 */

ok('URL 去掉 base 尾部斜杠', heartbeatUrl('https://mail.example.com///') === 'https://mail.example.com/api/imap/heartbeat');
ok('URL 正确拼接心跳接口', heartbeatUrl('https://mail.example.com') === 'https://mail.example.com/api/imap/heartbeat');
ok('readVersion 取自 package.json 且形如 x.y.z', /^\d+\.\d+\.\d+$/.test(readVersion()), readVersion());
ok('证书缺失时 certDaysLeft 返回 -1', certDaysLeft(path.join(tmp, 'nope.pem')) === -1);
ok('无效 PEM 时 certDaysLeft 返回 -1', (() => {
  const f = path.join(tmp, 'bad.pem'); fs.writeFileSync(f, 'not a cert');
  return certDaysLeft(f) === -1;
})());
const days = certDaysLeft(certFile);
ok('有效证书能算出剩余天数（长期测试证书 > 3000 天）', days > 3000, `实际 ${days}`);

/* ------------------------------------------------------------ payload */

const p = buildPayload({ env: BASE_ENV, certPath: certFile, now: 1763600000000, uptime: 86400 });
ok('payload 六个字段齐全', ['key', 'domain', 'version', 'certDays', 'uptime', 'ts']
  .every((k) => Object.prototype.hasOwnProperty.call(p, k)));
ok('payload.key 来自 HB_KEY', p.key === KEY);
ok('payload.domain 优先 HB_DOMAIN', p.domain === 'imap.example.com');
ok('payload.version 来自 package.json', /^\d+\.\d+\.\d+$/.test(p.version), p.version);
ok('payload.certDays 来自注入证书', p.certDays === days, `${p.certDays} vs ${days}`);
ok('payload.ts 为秒级时间戳', p.ts === 1763600000 && p.uptime === 86400);
ok('domain 可从 DOMAIN 回退', buildPayload({ env: { DOMAIN: 'imap.fallback.test', CERT_DIR: tmp }, certPath: certFile }).domain === 'imap.fallback.test');

/* ------------------------------------------------------------ 上报结果判定 */

let seen = null;
const goodFetch = async (url, init) => {
  seen = { url, init, body: JSON.parse(init.body) };
  return { status: 200, json: async () => ({ code: 200, message: 'success', data: { serverTime: '2026-11-20 09:00:00' } }) };
};
const sink = [];
const good = await sendHeartbeat({ env: BASE_ENV, fetchImpl: goodFetch, certPath: certFile, log: silentLog(sink) });
ok('成功：HTTP 200 + body.code 200 → ok:true', good.ok === true);
ok('请求 POST 到 /api/imap/heartbeat', seen?.init?.method === 'POST' && seen?.url === 'https://mail.example.com/api/imap/heartbeat');
ok('请求体带 key 与 domain', seen?.body?.key === KEY && seen?.body?.domain === 'imap.example.com');
ok('成功日志不含密钥', !sink.join(' ').includes(KEY));

const badFetch = async () => ({ status: 200, json: async () => ({ code: 401, message: 'unauthorized' }) });
const bad = await sendHeartbeat({ env: BASE_ENV, fetchImpl: badFetch, certPath: certFile, log: silentLog([]) });
ok('关键回归：HTTP 200 但 body.code=401 必须判失败', bad.ok === false && /401/.test(bad.reason), bad.reason);

const httpFail = await sendHeartbeat({
  env: BASE_ENV, certPath: certFile, log: silentLog([]),
  fetchImpl: async () => ({ status: 500, json: async () => ({ code: 500 }) })
});
ok('HTTP 500 判失败', httpFail.ok === false);

const netFail = await sendHeartbeat({
  env: BASE_ENV, certPath: certFile, log: silentLog([]),
  fetchImpl: async () => { throw new Error('ECONNRESET'); }
});
ok('网络异常返回 ok:false 且不抛出', netFail.ok === false && /ECONNRESET/.test(netFail.reason));

const junk = await sendHeartbeat({
  env: BASE_ENV, certPath: certFile, log: silentLog([]),
  fetchImpl: async () => ({ status: 200, json: async () => { throw new Error('not json'); } })
});
ok('响应非 JSON 判失败', junk.ok === false);

/* ------------------------------------------------------------ 启动/跳过 */

const noCalls = [];
const skipped = startHeartbeat({
  env: { CERT_DIR: tmp }, log: silentLog([]),
  fetchImpl: async () => { noCalls.push(1); return { status: 200, json: async () => ({ code: 200 }) }; }
});
ok('未配置 HB_URL/HB_KEY 时静默跳过（返回 null）', skipped === null && noCalls.length === 0);

const calls = [];
const started = startHeartbeat({
  env: { ...BASE_ENV, HB_INTERVAL_MS: '3600000' }, certPath: certFile, log: silentLog([]),
  fetchImpl: async () => { calls.push(1); return { status: 200, json: async () => ({ code: 200 }) }; }
});
await new Promise((r) => setImmediate(r));
ok('已配置时启动并立即上报一次', started !== null && typeof started.stop === 'function' && calls.length === 1, `调用 ${calls.length} 次`);
started?.stop();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`[verify-heartbeat] ${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.log(`  ! ${f}`);
  process.exit(1);
}
