/**
 * 防脚本（anti-abuse）行为测试：人机验证码 + 窗口冷却限流。
 *
 * 验证码：预约前必须答对一道算术题（token 一次性、短有效期、绑定 openid）。
 * 限流：同一 openid 同一写接口在冷却窗口内仅允许 1 次请求（anti_abuse 主键原子抢占）。
 */
const path = require('path');
const { test, assert, assertEqual } = require('./_lib.js');
const mock = require('./_mock_cloud.js');

const ROOT = path.resolve(__dirname, '..');
const CF = path.join(ROOT, 'cloudfunctions', 'cloud');

const config = require(path.join(CF, 'config/config.js'));
const timeUtil = require(path.join(CF, 'framework/utils/time_util.js'));
const appCode = require(path.join(CF, 'framework/core/app_code.js'));
const CaptchaService = require(path.join(CF, 'project/service/captcha_service.js'));
const ReservationService = require(path.join(CF, 'project/service/reservation_service.js'));
const initData = require(path.join(CF, 'project/init/init_data.js'));
const application = require(path.join(CF, 'framework/core/application.js'));

/* ---------------- 时钟控制 ---------------- */
const REAL_NOW = Date.now;
let fakeNow = REAL_NOW();

function setNow(dateStr, hhmmss) {
  const p = hhmmss.split(':').map(Number);
  fakeNow = timeUtil.dateMinuteToTimestamp(dateStr, p[0] * 60 + p[1]) + (p[2] || 0) * 1000;
  Date.now = () => fakeNow;
}
function restoreNow() {
  Date.now = REAL_NOW;
}

const TODAY = timeUtil.formatDate(REAL_NOW());

function t(name, fn) {
  test(name, async () => {
    try {
      await fn();
    } finally {
      restoreNow();
    }
  });
}

/* ---------------- 数据准备 ---------------- */
function seedBase() {
  mock.reset();
  mock.setOpenId('');
  for (const s of initData.TIME_SLOTS) {
    mock.seed(config.COLLECTION.time_slots, Object.assign({ _id: s.slot_key }, s));
  }
  for (const type of Object.keys(config.VENUE_TYPES)) {
    const info = config.VENUE_TYPES[type];
    for (let i = 1; i <= info.count; i++) {
      const key = type + '#' + i;
      mock.seed(config.COLLECTION.venues, {
        _id: key, venue_key: key, venue_type: type, venue_type_name: info.name,
        court_no: i, closed: false, closed_until: 0, update_time: 0,
      });
    }
  }
  mock.seed(config.COLLECTION.configs, {
    _id: 'open_time', key: 'open_time', value: config.DEFAULT_OPEN_TIME,
  });
  mock.seed(config.COLLECTION.users, {
    _id: 'stu_A', openid: 'stu_A', role: 1, name: '张三', student_no: '2023001',
    phone: '13800000000', college: '机械', info_completed: true, status: 1, black_until: 0,
    create_time: 0, update_time: 0,
  });
  mock.seed(config.COLLECTION.users, {
    _id: 'stu_B', openid: 'stu_B', role: 1, name: '李四', student_no: '2023002',
    phone: '13800000001', college: '机械', info_completed: true, status: 1, black_until: 0,
    create_time: 0, update_time: 0,
  });
  mock.setUniqueIndexes([]);
}

function userOf(id) {
  return mock.dump(config.COLLECTION.users).find((u) => u._id === id);
}

/** 解析题目 "7 + 6 = ?" 得到正确答案字符串 */
function solve(q) {
  const m = /^(\d+)\s*([+\-×])\s*(\d+)\s*=\s*\?$/.exec(String(q).trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  if (m[2] === '+') return String(a + b);
  if (m[2] === '-') return String(a - b);
  if (m[2] === '×') return String(a * b);
  return null;
}

function book(openid, opts) {
  return new ReservationService().create(openid, userOf(openid), opts);
}

async function expectOk(fn, label) {
  try {
    return await fn();
  } catch (e) {
    throw new Error(label + ' 期望成功，实际失败：' + (e.code || e.name) + ' ' + e.message);
  }
}

async function expectErr(fn, code, label) {
  try {
    await fn();
  } catch (e) {
    if (e.code !== code) {
      throw new Error(label + ' 期望错误码 ' + code + '，实际 ' + e.code + ' ' + e.message);
    }
    return e;
  }
  throw new Error(label + ' 期望失败(' + code + ')，实际成功');
}

/* ================= 1. 验证码生成与校验 ================= */
t('验证码 issue 返回 token + 可解题目 + 有效期 120s', async () => {
  seedBase();
  const cap = await new CaptchaService().issue('stu_A');
  assert(cap.token, '应返回 token');
  assert(solve(cap.question) !== null, '题目应可解：' + cap.question);
  assertEqual(cap.expire_seconds, 120);
  assertEqual(mock.size(config.COLLECTION.captchas), 1, '应落库 1 条验证码');
});

t('验证码正确答案通过 + 一次性消费（复用被拒 4201）', async () => {
  seedBase();
  const svc = new CaptchaService();
  const cap = await svc.issue('stu_A');
  const ans = solve(cap.question);
  await expectOk(() => svc.verify('stu_A', cap.token, ans), '正确答案校验');
  assertEqual(mock.dump(config.COLLECTION.captchas)[0].used, 1, '验证码应标记已用');
  await expectErr(() => svc.verify('stu_A', cap.token, ans), appCode.CAPTCHA_INVALID, '复用已用验证码');
});

t('验证码答案错误 → 4202，且不消费（可用正确答案重试）', async () => {
  seedBase();
  const svc = new CaptchaService();
  const cap = await svc.issue('stu_A');
  const ans = solve(cap.question);
  const wrong = ans === '0' ? '1' : '0';
  await expectErr(() => svc.verify('stu_A', cap.token, wrong), appCode.CAPTCHA_WRONG, '错误答案');
  assertEqual(mock.dump(config.COLLECTION.captchas)[0].used, 0, '答错不应消费验证码');
  await expectOk(() => svc.verify('stu_A', cap.token, ans), '答错后用正确答案重试');
});

t('验证码过期 → 4201', async () => {
  seedBase();
  setNow(TODAY, '10:00:00');
  const svc = new CaptchaService();
  const cap = await svc.issue('stu_A');
  setNow(TODAY, '10:02:01'); // 超过 120s 有效期
  await expectErr(() => svc.verify('stu_A', cap.token, solve(cap.question)), appCode.CAPTCHA_INVALID, '过期验证码');
});

t('验证码跨用户不可用 → 4201', async () => {
  seedBase();
  setNow(TODAY, '10:00:00');
  const svc = new CaptchaService();
  const cap = await svc.issue('stu_A');
  await expectErr(() => svc.verify('stu_B', cap.token, solve(cap.question)), appCode.CAPTCHA_INVALID, '跨用户使用验证码');
});

t('缺 token / 缺答案 → 4200', async () => {
  seedBase();
  const svc = new CaptchaService();
  await expectErr(() => svc.verify('stu_A', '', '3'), appCode.CAPTCHA_REQUIRED, '缺 token');
  await expectErr(() => svc.verify('stu_A', 'some_token', ''), appCode.CAPTCHA_REQUIRED, '缺答案');
});

/* ================= 2. 预约接口接入验证码 ================= */
t('预约不带验证码 → 4200，且不留占用', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  await expectErr(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1' }),
    appCode.CAPTCHA_REQUIRED, '不带验证码预约');
  assertEqual(mock.size(config.COLLECTION.reservations), 0, '被拒后不应留下占用记录');
});

t('预约验证码答错 → 4202，答对 → 预约成功', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  const svc = new CaptchaService();
  const cap = await svc.issue('stu_A');
  const ans = solve(cap.question);
  const wrong = ans === '0' ? '1' : '0';
  await expectErr(() => book('stu_A', {
    date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1',
    captcha_token: cap.token, captcha_answer: wrong,
  }), appCode.CAPTCHA_WRONG, '验证码答错');
  await expectOk(() => book('stu_A', {
    date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1',
    captcha_token: cap.token, captcha_answer: ans,
  }), '验证码答对预约');
  assertEqual(mock.size(config.COLLECTION.reservations), 1, '预约成功后占用 1 条');
});

/* ================= 3. 窗口冷却限流 ================= */
t('checkRateLimit：同窗口第二次 → 4203，跨窗口放行', async () => {
  seedBase();
  const svc = new CaptchaService();
  setNow(TODAY, '10:00:00');
  await expectOk(() => svc.checkRateLimit('stu_A', 'reservation/create'), '窗口内首次');
  await expectErr(() => svc.checkRateLimit('stu_A', 'reservation/create'), appCode.TOO_FREQUENT, '窗口内第二次');
  setNow(TODAY, '10:00:03'); // 推进 3 秒（窗口 3000ms）
  await expectOk(() => svc.checkRateLimit('stu_A', 'reservation/create'), '跨窗口放行');
});

t('checkRateLimit：不在清单的接口放行，不同用户互不影响', async () => {
  seedBase();
  const svc = new CaptchaService();
  setNow(TODAY, '10:00:00');
  await expectOk(() => svc.checkRateLimit('stu_A', 'venue/list'), '非限流接口放行');
  await expectOk(() => svc.checkRateLimit('stu_A', 'reservation/create'), 'A 首次');
  await expectOk(() => svc.checkRateLimit('stu_B', 'reservation/create'), 'B 首次不受 A 影响');
});

/* ================= 4. application 中间件限流 ================= */
t('application 中间件：预约接口同窗口二次请求 → 4203（先于验证码拦截）', async () => {
  seedBase();
  setNow(TODAY, '10:00:00');
  mock.setOpenId('stu_A');
  const svc = new CaptchaService();

  const cap1 = await svc.issue('stu_A');
  const r1 = await application.app({
    route: 'reservation/create', date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1',
    captcha_token: cap1.token, captcha_answer: solve(cap1.question),
  }, {});
  assertEqual(r1.code, 200, '首次预约应成功');

  // 同窗口第二次：即使带上新验证码，也应被限流中间件先行拦截
  const cap2 = await svc.issue('stu_A');
  const r2 = await application.app({
    route: 'reservation/create', date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#2',
    captcha_token: cap2.token, captcha_answer: solve(cap2.question),
  }, {});
  assertEqual(r2.code, appCode.TOO_FREQUENT, '同窗口第二次应限流');
});
