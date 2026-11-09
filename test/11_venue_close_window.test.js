/**
 * 场地临时闭馆「按场次时间窗」判定回归测试
 *
 * 复现场景：1 号羽毛球场临时闭馆，恢复时间 19:35
 *   19:40-20:50 场次（开始时间晚于恢复时间）→ 应可预约
 *   18:20-19:30 场次（开始时间早于恢复时间）→ 仍闭馆锁定
 * 旧逻辑用「恢复时间 vs 当前时间」，恢复时间没到就把当天全部场次锁死，本文件锁死该行为。
 */
const path = require('path');
const { test, assert, assertEqual } = require('./_lib.js');
const mock = require('./_mock_cloud.js');

const ROOT = path.resolve(__dirname, '..');
const CF = path.join(ROOT, 'cloudfunctions', 'cloud');

const config = require(path.join(CF, 'config/config.js'));
const timeUtil = require(path.join(CF, 'framework/utils/time_util.js'));
const appCode = require(path.join(CF, 'framework/core/app_code.js'));
const ReservationService = require(path.join(CF, 'project/service/reservation_service.js'));
const VenueService = require(path.join(CF, 'project/service/venue_service.js'));
const CheckinService = require(path.join(CF, 'project/service/checkin_service.js'));
const initData = require(path.join(CF, 'project/init/init_data.js'));
const application = require(path.join(CF, 'framework/core/application.js'));

/* ---------------- 时钟控制 ---------------- */
const REAL_NOW = Date.now;
let fakeNow = REAL_NOW();

function setNow(dateStr, hhmm) {
  const parts = hhmm.split(':').map(Number);
  fakeNow = timeUtil.dateMinuteToTimestamp(dateStr, parts[0] * 60 + parts[1]) + (parts[2] || 0) * 1000;
  Date.now = () => fakeNow;
}
function restoreNow() {
  Date.now = REAL_NOW;
}
function t(name, fn) {
  test(name, async () => {
    try {
      await fn();
    } finally {
      restoreNow();
    }
  });
}

const TODAY = timeUtil.formatDate(REAL_NOW());
const TOMORROW = timeUtil.addDays(TODAY, 1);
/** 当天某时刻的时间戳 */
function at(hhmm) {
  return timeUtil.dateMinuteToTimestamp(TODAY, timeUtil.timeToMin(hhmm));
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
  mock.seed(config.COLLECTION.users, {
    _id: 'adm_1', openid: 'adm_1', role: 2, name: '管理员', info_completed: true, status: 1,
    black_until: 0, create_time: 0, update_time: 0,
  });
  mock.setUniqueIndexes([{
    coll: config.COLLECTION.reservations,
    name: 'uniq_student_slot',
    fields: ['student_openid', 'date', 'slot_key'],
  }]);
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
  let ret;
  try {
    ret = await fn();
  } catch (e) {
    if (e.code !== code) {
      throw new Error(label + ' 期望错误码 ' + code + '，实际 ' + e.code + ' ' + e.message);
    }
    return e;
  }
  throw new Error(label + ' 期望失败(' + code + ')，实际成功：' + JSON.stringify(ret));
}
function courtStatus(list, key) {
  const row = list.find((v) => v.venue_key === key);
  assert(row, '应能查到场地 ' + key);
  return row;
}

/* ================= 1. 核心复现场景 ================= */
t('闭馆至 19:35：19:40 场次可预约，18:20 场次仍闭馆', async () => {
  seedBase();
  setNow(TODAY, '18:00');
  await expectOk(() => new VenueService().close(userOf('adm_1'),
    { venue_key: 'badminton#1', closed: true, closed_until: at('19:35') }), '设置临时闭馆');

  const early = await expectOk(() => new ReservationService().status(
    { date: TODAY, slot_key: '1820_1930', venue_type: 'badminton' }), '查询 18:20 场次状态');
  const earlyCourt = courtStatus(early, 'badminton#1');
  assertEqual(earlyCourt.status, 'closed', '18:20-19:30 开始时间早于 19:35，应保持闭馆');
  assertEqual(earlyCourt.closed_until_text, '19:35', '闭馆应带出恢复时刻文案');

  const late = await expectOk(() => new ReservationService().status(
    { date: TODAY, slot_key: '1940_2050', venue_type: 'badminton' }), '查询 19:40 场次状态');
  const lateCourt = courtStatus(late, 'badminton#1');
  assertEqual(lateCourt.status, 'available', '19:40-20:50 开始时间晚于 19:35，应可预约');
  assertEqual(lateCourt.closed_until_text, '', '可预约场次不应带闭馆文案');
});

t('恢复时刻之后开始的场次可正常提交预约，之前的场次返回 4106', async () => {
  seedBase();
  setNow(TODAY, '18:00');
  await expectOk(() => new VenueService().close(userOf('adm_1'),
    { venue_key: 'badminton#1', closed: true, closed_until: at('19:35') }), '设置临时闭馆');

  await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1940_2050', venue_key: 'badminton#1' }), '预约 19:40 场次');

  const e = await expectErr(() => book('stu_B', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1' }),
    appCode.VENUE_CLOSED, '预约 18:20 场次');
  assert(e.message.indexOf('19:35') >= 0, '错误提示应带恢复时刻，实际：' + e.message);
});

t('路由层：临时闭馆后 19:40 场次可提交，18:20 场次返回 4106 且带恢复时刻', async () => {
  seedBase();
  setNow(TODAY, '18:00');
  await expectOk(() => new VenueService().close(userOf('adm_1'),
    { venue_key: 'badminton#1', closed: true, closed_until: at('19:35') }), '设置临时闭馆');
  mock.setOpenId('stu_A');

  const st = await application.app(
    { route: 'reservation/status', date: TODAY, slot_key: '1940_2050', venue_type: 'badminton' }, {});
  assertEqual(st.code, 200, 'status 应成功');
  assertEqual(courtStatus(st.data, 'badminton#1').status, 'available', '19:40 场次应可预约');

  const ok = await application.app(
    { route: 'reservation/create', date: TODAY, slot_key: '1940_2050', venue_key: 'badminton#1' }, {});
  assertEqual(ok.code, 200, '19:40 场次预约应成功，实际：' + ok.msg);

  mock.setOpenId('stu_B');
  const bad = await application.app(
    { route: 'reservation/create', date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1' }, {});
  assertEqual(bad.code, appCode.VENUE_CLOSED, '18:20 场次应返回 4106');
  assert(bad.msg.indexOf('19:35') >= 0, '错误文案应带恢复时刻，实际：' + bad.msg);
});

/* ================= 2. 边界与失效 ================= */t('场次开始时间正好等于恢复时刻：不拦截（边界取等）', async () => {
  seedBase();
  setNow(TODAY, '18:00');
  await expectOk(() => new VenueService().close(userOf('adm_1'),
    { venue_key: 'badminton#1', closed: true, closed_until: at('19:40') }), '设置临时闭馆');

  const late = await expectOk(() => new ReservationService().status(
    { date: TODAY, slot_key: '1940_2050', venue_type: 'badminton' }), '查询 19:40 场次');
  assertEqual(courtStatus(late, 'badminton#1').status, 'available', '19:40 开始 = 19:40 恢复，应可预约');
});

t('恢复时刻已过：即使 closed 标记还在，也自动解除闭馆', async () => {
  seedBase();
  setNow(TODAY, '18:00');
  await expectOk(() => new VenueService().close(userOf('adm_1'),
    { venue_key: 'badminton#1', closed: true, closed_until: at('19:35') }), '设置临时闭馆');

  setNow(TODAY, '19:50');
  const list = await expectOk(() => new VenueService().list(), '场馆列表');
  const badminton = list.find((g) => g.venue_type === 'badminton');
  assertEqual(courtStatus(badminton.courts, 'badminton#1').closed, false, '恢复时刻已过，应显示开放');

  const late = await expectOk(() => new ReservationService().status(
    { date: TODAY, slot_key: '1940_2050', venue_type: 'badminton' }), '查询 19:40 场次');
  assertEqual(courtStatus(late, 'badminton#1').status, 'available', '恢复后场次可预约');
});

t('永久闭馆（closed_until=0）仍然锁定全部场次', async () => {
  seedBase();
  setNow(TODAY, '18:00');
  await expectOk(() => new VenueService().close(userOf('adm_1'),
    { venue_key: 'pingpong#1', closed: true, closed_until: 0 }), '设置永久闭馆');

  for (const slotKey of ['1820_1930', '1940_2050']) {
    const list = await expectOk(() => new ReservationService().status(
      { date: TODAY, slot_key: slotKey, venue_type: 'pingpong' }), '查询 ' + slotKey);
    assertEqual(courtStatus(list, 'pingpong#1').status, 'closed', slotKey + ' 应闭馆');
  }
  await expectErr(() => book('stu_A', { date: TODAY, slot_key: '1940_2050', venue_key: 'pingpong#1' }),
    appCode.VENUE_CLOSED, '永久闭馆不可预约');
});

t('临时闭馆不影响次日场次（恢复时间在今天）', async () => {
  seedBase();
  setNow(TODAY, '18:00');
  await expectOk(() => new VenueService().close(userOf('adm_1'),
    { venue_key: 'badminton#2', closed: true, closed_until: at('19:35') }), '设置临时闭馆');

  const next = await expectOk(() => new ReservationService().status(
    { date: TOMORROW, slot_key: '1820_1930', venue_type: 'badminton' }), '查询次日场次');
  assertEqual(courtStatus(next, 'badminton#2').status, 'available', '次日场次开始时间晚于恢复时刻，应可预约');
});

/* ================= 3. 闭馆联动取消的范围 ================= */
t('临时闭馆只取消恢复前的预约，恢复后的预约保留', async () => {
  seedBase();
  setNow(TODAY, '18:00');
  await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1' }), '预约 18:20 场次');
  await expectOk(() => book('stu_B', { date: TODAY, slot_key: '1940_2050', venue_key: 'badminton#1' }), '预约 19:40 场次');
  assertEqual(mock.size(config.COLLECTION.reservations), 2, '闭馆前应有 2 条占用');

  const ret = await expectOk(() => new VenueService().close(userOf('adm_1'),
    { venue_key: 'badminton#1', closed: true, closed_until: at('19:35') }), '设置临时闭馆');
  assertEqual(ret.cancelled_bookings, 1, '只应取消恢复时刻之前的 1 条预约');

  const left = mock.dump(config.COLLECTION.reservations);
  assertEqual(left.length, 1, '恢复之后的预约应保留');
  assertEqual(left[0].slot_key, '1940_2050', '保留的应是 19:40 场次');

  const recs = mock.dump(config.COLLECTION.reservation_records);
  const bySlot = {};
  recs.forEach((r) => { bySlot[r.slot_key] = r.status; });
  assertEqual(bySlot['1820_1930'], 'cancelled', '18:20 场次流水应 cancelled');
  assertEqual(bySlot['1940_2050'], 'pending', '19:40 场次流水应保持 pending');
  assertEqual(mock.size(config.COLLECTION.student_slot_locks), 1, '保留预约的时段锁应仍在');
});

/* ================= 4. 签到同样按场次判定 ================= */
t('签到按场次判定：恢复后可签，恢复前的场次拒绝', async () => {
  seedBase();
  setNow(TODAY, '18:20');
  await expectOk(() => new VenueService().close(userOf('adm_1'),
    { venue_key: 'badminton#1', closed: true, closed_until: at('19:35') }), '设置临时闭馆');

  const earlyId = TODAY + '_1820_1930_badminton#1';
  mock.seed(config.COLLECTION.reservations, {
    _id: earlyId, student_openid: 'stu_A', student_name: '张三', student_no: '2023001',
    date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1', venue_type: 'badminton',
    court_no: 1, status: 'pending', checkin_time: 0, create_time: 0,
  });
  await expectErr(() => new CheckinService().checkin(userOf('adm_1'), { res_id: earlyId, slot_key: '1820_1930' }),
    appCode.VENUE_CLOSED, '闭馆时段内签到');

  // 19:25 签到 19:40 场次：此刻场地还没恢复，但场次在恢复之后才开始 → 允许
  setNow(TODAY, '19:25');
  const lateId = TODAY + '_1940_2050_badminton#1';
  mock.seed(config.COLLECTION.reservations, {
    _id: lateId, student_openid: 'stu_B', student_name: '李四', student_no: '2023002',
    date: TODAY, slot_key: '1940_2050', venue_key: 'badminton#1', venue_type: 'badminton',
    court_no: 1, status: 'pending', checkin_time: 0, create_time: 0,
  });
  const ret = await expectOk(() => new CheckinService().checkin(userOf('adm_1'),
    { res_id: lateId, slot_key: '1940_2050' }), '恢复后场次签到');
  assert(ret.checkin_time > 0, '签到应返回签到时间');
  assertEqual(mock.dump(config.COLLECTION.reservations).find((r) => r._id === lateId).status, 'checked_in', '占用应置 checked_in');
});
