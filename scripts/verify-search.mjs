/**
 * [S37] SEARCH 条件求值自检（v0.2.14）
 *
 * 背景：库能解析出 all/new/flag/header/date/size/text/uid/not/or/sequence，
 * 旧实现只认其中一小部分，其余被静默忽略 —— 实测 SINCE 2027 / BEFORE 2020 /
 * LARGER 60000 / SMALLER 700 / OR / ANSWERED / DELETED 全部返回全量。
 * 这里把每类条件逐一钉死，含 NOT/OR 嵌套与未知类型的「必须不匹配」。
 *
 * 用法：node scripts/verify-search.mjs
 */
import { matchCriterion } from '../src/adapters.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 站内列表行的字段形态（email/list 返回）
const mail = (over = {}) => ({
  emailId: 100,
  unread: 1,              // 1=已读 0=未读
  isStarred: false,
  subject: 'Pay Links for your domain',
  sendEmail: 'noreply@squarespace.com',
  name: 'Squarespace',
  toEmail: 'you@example.com',
  cc: '[]',
  text: 'plain body text',
  size: 56372,
  createTime: '2026-08-19 14:31:22',
  ...over,
});

const C = (o) => ({ type: 'flag', ...o });

console.log('▶ 标志类');
check('SEEN 命中已读', matchCriterion(C({ flag: '\\Seen' }), mail()));
check('SEEN 不命中未读', !matchCriterion(C({ flag: '\\Seen' }), mail({ unread: 0 })));
check('UNSEEN(=NOT SEEN) 命中未读', matchCriterion(C({ flag: '\\Seen', negated: true }), mail({ unread: 0 })));
check('FLAGGED 命中星标', matchCriterion(C({ flag: '\\Flagged' }), mail({ isStarred: true })));
// [v0.2.14] 列表行真实字段是 isStar（0/1），旧代码读 isStarred 恒 undefined
check('FLAGGED 命中 isStar=1（列表真实字段）', matchCriterion(C({ flag: '\\Flagged' }), mail({ isStar: 1 })));
check('FLAGGED 不命中 isStar=0', !matchCriterion(C({ flag: '\\Flagged' }), mail({ isStar: 0 })));
check('FLAGGED 命中 starId（详情字段）', matchCriterion(C({ flag: '\\Flagged' }), mail({ starId: 5 })));
check('\\Answered 一律不匹配（站内无此状态）', !matchCriterion(C({ flag: '\\Answered' }), mail()));
check('UNANSWERED 匹配全部', matchCriterion(C({ flag: '\\Answered', negated: true }), mail()));
check('\\Deleted 一律不匹配', !matchCriterion(C({ flag: '\\Deleted' }), mail()));
check('UNDELETED 匹配全部', matchCriterion(C({ flag: '\\Deleted', negated: true }), mail()));

console.log('▶ 日期类');
check('SINCE 2026-08-01 命中 8 月邮件', matchCriterion({ type: 'date', comparison: 'since', date: '1-Aug-2026' }, mail()));
check('SINCE 2027-01-01 不命中', !matchCriterion({ type: 'date', comparison: 'since', date: '1-Jan-2027' }, mail()));
check('BEFORE 2020-01-01 不命中', !matchCriterion({ type: 'date', comparison: 'before', date: '1-Jan-2020' }, mail()));
check('BEFORE 2027-01-01 命中', matchCriterion({ type: 'date', comparison: 'before', date: '1-Jan-2027' }, mail()));
check('ON 2026-08-19 命中当天', matchCriterion({ type: 'date', comparison: 'on', date: '19-Aug-2026' }, mail()));
check('ON 2026-08-20 不命中', !matchCriterion({ type: 'date', comparison: 'on', date: '20-Aug-2026' }, mail()));
check('非法日期不命中（不静默放行）', !matchCriterion({ type: 'date', comparison: 'since', date: 'garbage' }, mail()));

console.log('▶ 大小类');
check('LARGER 1000 命中 56KB', matchCriterion({ type: 'size', comparison: 'larger', size: 1000 }, mail()));
check('LARGER 60000 不命中 56KB', !matchCriterion({ type: 'size', comparison: 'larger', size: 60000 }, mail()));
check('SMALLER 1000 不命中 56KB', !matchCriterion({ type: 'size', comparison: 'smaller', size: 1000 }, mail()));
check('SMALLER 60000 命中 56KB', matchCriterion({ type: 'size', comparison: 'smaller', size: 60000 }, mail()));
check('大小比较用 size 字段缺省不炸', !matchCriterion({ type: 'size', comparison: 'larger', size: 10 }, mail({ size: undefined })));

console.log('▶ 头字段类');
check('FROM 命中发件地址', matchCriterion({ type: 'header', field: 'from', value: 'squarespace' }, mail()));
check('SUBJECT 命中标题', matchCriterion({ type: 'header', field: 'subject', value: 'pay links' }, mail()));
check('TO 命中收件人', matchCriterion({ type: 'header', field: 'to', value: 'you@example.com' }, mail()));
check('CC 命中 cc 里的地址', matchCriterion({ type: 'header', field: 'cc', value: 'boss@x.com' },
  mail({ cc: JSON.stringify([{ address: 'boss@x.com', name: 'Boss' }]) })));
check('CC 不命中时返回 false', !matchCriterion({ type: 'header', field: 'cc', value: 'nobody@x.com' }, mail()));
check('未知头字段不匹配（不静默放行）', !matchCriterion({ type: 'header', field: 'x-mailer', value: 'foo' }, mail()));
check('空值视为不过滤', matchCriterion({ type: 'header', field: 'subject', value: '' }, mail()));

console.log('▶ 文本类');
check('TEXT 命中正文', matchCriterion({ type: 'text', scope: 'text', value: 'plain body' }, mail()));
check('BODY 命中正文', matchCriterion({ type: 'text', scope: 'body', value: 'plain body' }, mail()));
check('TEXT 不命中', !matchCriterion({ type: 'text', scope: 'text', value: 'zzzz' }, mail()));

console.log('▶ 组合与 UID');
check('NOT (SUBJECT x) 取反', !matchCriterion({ type: 'not', criterion: { type: 'header', field: 'subject', value: 'pay' } }, mail()));
check('OR 左命中', matchCriterion({ type: 'or', left: { type: 'header', field: 'subject', value: 'pay' }, right: { type: 'size', comparison: 'larger', size: 999999 } }, mail()));
check('OR 右命中', matchCriterion({ type: 'or', left: { type: 'header', field: 'subject', value: 'zzz' }, right: { type: 'size', comparison: 'larger', size: 1 } }, mail()));
check('OR 都不命中', !matchCriterion({ type: 'or', left: { type: 'header', field: 'subject', value: 'zzz' }, right: { type: 'size', comparison: 'larger', size: 999999 } }, mail()));
check('UID 集合命中', matchCriterion({ type: 'uid', set: [{ start: 90, end: 110 }] }, mail()));
check('UID 集合不命中', !matchCriterion({ type: 'uid', set: [{ start: 1, end: 50 }] }, mail()));
check('UID 单值命中', matchCriterion({ type: 'uid', set: [{ start: 100 }] }, mail()));

console.log('▶ 语义自洽');
check('ALL 命中', matchCriterion({ type: 'all' }, mail()));
check('NEW 不命中（STATUS RECENT 恒 0）', !matchCriterion({ type: 'new' }, mail({ unread: 0 })));

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
