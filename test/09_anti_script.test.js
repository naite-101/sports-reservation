/**
 * 防脚本（anti-abuse）行为测试：纯服务端窗口冷却限流（无感人机验证替代）。
 *
 * 已移除算术验证码（伤真人 + 防不住 AI 秒答脚本），改为：
 *   「微信登录 openid 唯一 + 窗口冷却限流」双保险。
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
const RateLimitService = require(path.join(CF, 'project/service/rate_limit_service.js'));
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

/* ================= 1. 窗口冷却限流 ================= */
t('checkRateLimit：同窗口第二次 → 4203，跨窗口放行', async () => {
  seedBase();
  const svc = new RateLimitService();
  setNow(TODAY, '10:00:00');
  await expectOk(() => svc.checkRateLimit('stu_A', 'reservation/create'), '窗口内首次');
  await expectErr(() => svc.checkRateLimit('stu_A', 'reservation/create'), appCode.TOO_FREQUENT, '窗口内第二次');
  setNow(TODAY, '10:00:03'); // 推进 3 秒（窗口 3000ms）
  await expectOk(() => svc.checkRateLimit('stu_A', 'reservation/create'), '跨窗口放行');
});

t('checkRateLimit：不在清单的接口放行，不同用户互不影响', async () => {
  seedBase();
  const svc = new RateLimitService();
  setNow(TODAY, '10:00:00');
  await expectOk(() => svc.checkRateLimit('stu_A', 'venue/list'), '非限流接口放行');
  await expectOk(() => svc.checkRateLimit('stu_A', 'reservation/create'), 'A 首次');
  await expectOk(() => svc.checkRateLimit('stu_B', 'reservation/create'), 'B 首次不受 A 影响');
});

/* ================= 2. 预约无需验证码，直接提交 ================= */
t('预约不带验证码直接成功（已移除人机验证码）', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1' }), '不带验证码预约');
  assertEqual(mock.size(config.COLLECTION.reservations), 1, '预约成功后占用 1 条');
});

/* ================= 3. application 中间件限流 ================= */
t('application 中间件：预约接口同窗口二次请求 → 4203', async () => {
  seedBase();
  setNow(TODAY, '10:00:00');
  mock.setOpenId('stu_A');

  const r1 = await application.app({
    route: 'reservation/create', date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1',
  }, {});
  assertEqual(r1.code, 200, '首次预约应成功');

  // 同窗口第二次：即使换场地，也应被限流中间件先行拦截
  const r2 = await application.app({
    route: 'reservation/create', date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#2',
  }, {});
  assertEqual(r2.code, appCode.TOO_FREQUENT, '同窗口第二次应限流');
});

t('application 中间件：跨窗口后限流放行，进入业务校验', async () => {
  seedBase();
  setNow(TODAY, '10:00:00');
  mock.setOpenId('stu_A');

  const r1 = await application.app({
    route: 'reservation/create', date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1',
  }, {});
  assertEqual(r1.code, 200, '首次预约应成功');

  setNow(TODAY, '10:00:03'); // 跨窗口
  const r2 = await application.app({
    route: 'reservation/create', date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#2',
  }, {});
  // 限流已放行，进入业务校验：stu_A 同场次已约 badminton#1，约 #2 触发 DUPLICATE_SLOT(4101)
  assertEqual(r2.code, appCode.DUPLICATE_SLOT, '跨窗口后限流放行（进入业务校验 4101）');
});
