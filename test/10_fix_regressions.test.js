/**
 * 10_fix_regressions：审计修复回归（H-4/H-5/M-2/M-5/M-6/M-9/L 系列）
 * 覆盖：
 *  - M-5 reservation/status 计入 checked_in 占用
 *  - M-6 cancel 状态守卫 + 流水与占用/锁同事务
 *  - M-9 闭馆联动释放锁、job/expire 孤儿锁清扫
 *  - L-1 公告发布写操作日志
 *  - L-2 job/expire 清理过期 anti_abuse 限流记录
 *  - L-4 job/expire 清理过期 checked_in 占用
 *  - L-5 closed_until / open_time hour/minute 边界校验
 *  - L-6 notice/detail 不暴露 author_openid/status
 *  - L-8 hr/studentDetail 不可查看超管/人事 PII
 *  - M-2 伪造 TriggerName 不再触发定时任务
 *  - H-5 smoke/run 需 ENABLE_SMOKE 环境开关
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
const JobService = require(path.join(CF, 'project/service/job_service.js'));
const NoticeService = require(path.join(CF, 'project/service/notice_service.js'));
const ConfigService = require(path.join(CF, 'project/service/config_service.js'));
const HrService = require(path.join(CF, 'project/service/hr_service.js'));
const ReservationModel = require(path.join(CF, 'project/model/reservation_model.js'));
const MyController = require(path.join(CF, 'project/controller/my_controller.js'));
const indexEntry = require(path.join(CF, 'index.js'));
const initData = require(path.join(CF, 'project/init/init_data.js'));
const application = require(path.join(CF, 'framework/core/application.js'));

/* ---------------- 时钟控制 ---------------- */
const REAL_NOW = Date.now;
let fakeNow = REAL_NOW();

function setNow(dateStr, hhmmss) {
  const parts = hhmmss.split(':').map(Number);
  fakeNow = timeUtil.dateMinuteToTimestamp(dateStr, parts[0] * 60 + parts[1]) + (parts[2] || 0) * 1000;
  Date.now = () => fakeNow;
}
function restoreNow() {
  Date.now = REAL_NOW;
}

const TODAY = timeUtil.formatDate(REAL_NOW());
const TOMORROW = timeUtil.addDays(TODAY, 1);

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
    _id: 'adm_1', openid: 'adm_1', role: 2, name: '管理员', info_completed: true, status: 1,
    black_until: 0, create_time: 0, update_time: 0,
  });
  mock.seed(config.COLLECTION.users, {
    _id: 'sa_1', openid: 'sa_1', role: 3, name: '赵超管', info_completed: true, status: 1,
    black_until: 0, create_time: 0, update_time: 0,
  });
  mock.seed(config.COLLECTION.users, {
    _id: 'hr_1', openid: 'hr_1', role: 4, name: '王人事', info_completed: true, status: 1,
    black_until: 0, create_time: 0, update_time: 0,
  });
}

function userOf(id) {
  return mock.dump(config.COLLECTION.users).find((u) => u._id === id);
}

async function book(openid, opts) {
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

/* ================= M-5：status 计入 checked_in ================= */
t('M-5：已签到(checked_in)的场地在场次进行中显示 booked，不再误报 available', async () => {
  seedBase();
  setNow(TODAY, '18:00'); // 开场前先预约
  await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1' }), '预约');
  setNow(TODAY, '18:25'); // 场次 18:20~19:30 进行中
  // 模拟签到后的占用状态
  await ReservationModel.edit(TODAY + '_1820_1930_badminton#1', { status: 'checked_in' });

  const list = await new ReservationService().status({ date: TODAY, slot_key: '1820_1930', venue_type: 'badminton' });
  const v1 = list.find((v) => v.venue_key === 'badminton#1');
  assertEqual(v1.status, 'booked', 'checked_in 占用应显示 booked');
  const v2 = list.find((v) => v.venue_key === 'badminton#2');
  assertEqual(v2.status, 'available', '未占用场地仍为 available');
});

/* ================= M-6：cancel 状态守卫 + 流水同事务 ================= */
t('M-6：已签到订单不可取消（状态守卫）', async () => {
  seedBase();
  setNow(TODAY, '18:00');
  await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1' }), '预约');
  await ReservationModel.edit(TODAY + '_1820_1930_badminton#1', { status: 'checked_in' });

  await expectErr(() => new ReservationService().cancel('stu_A', { res_id: TODAY + '_1820_1930_badminton#1' }),
    appCode.LOGIC, '取消已签到订单');
});

t('M-6：正常取消后流水同事务置 cancelled（不留 pending 残留）', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1' }), '预约');
  await expectOk(() => new ReservationService().cancel('stu_A', { res_id: TODAY + '_1820_1930_badminton#1' }), '取消');

  const recs = mock.dump(config.COLLECTION.reservation_records).filter((r) => r.res_id === TODAY + '_1820_1930_badminton#1');
  assertEqual(recs.length, 1, '应有 1 条流水');
  assertEqual(recs[0].status, 'cancelled', '流水应同事务置 cancelled');
  assertEqual(mock.size(config.COLLECTION.reservations), 0, '占用应已删除');
  assertEqual(mock.size(config.COLLECTION.student_slot_locks), 0, '锁应同事务删除');
});

/* ================= M-9：闭馆联动释放锁 + 孤儿锁清扫 ================= */
t('M-9：闭馆联动取消预约时同时释放学生时段锁', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1' }), '预约');
  assertEqual(mock.size(config.COLLECTION.student_slot_locks), 1, '预约后应有 1 把锁');

  await expectOk(() => new VenueService().close(userOf('sa_1'), { venue_key: 'badminton#1', closed: true }), '闭馆');
  assertEqual(mock.size(config.COLLECTION.reservations), 0, '占用应被联动取消');
  assertEqual(mock.size(config.COLLECTION.student_slot_locks), 0, '锁应同事务释放（M-9 核心）');
});

t('M-9：job/expire 孤儿锁清扫——cancelled 流水残留的锁被清掉', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  // 手工构造残留：锁在、占用已删、流水已 cancelled
  mock.seed(config.COLLECTION.student_slot_locks, {
    _id: 'stu_A_' + TODAY + '_1820_1930', student_openid: 'stu_A', date: TODAY,
    slot_key: '1820_1930', venue_key: 'badminton#1', res_id: 'ghost_res', create_time: 1,
  });
  mock.seed(config.COLLECTION.reservation_records, {
    _id: 'rec_ghost', res_id: 'ghost_res', student_openid: 'stu_A', date: TODAY,
    slot_key: '1820_1930', status: 'cancelled', create_time: 1, update_time: 1,
  });

  const res = await expectOk(() => new JobService().expire(), 'expire');
  assert(res.locks_cleaned >= 1, '应清扫至少 1 把孤儿锁，实际 ' + res.locks_cleaned);
  assertEqual(mock.size(config.COLLECTION.student_slot_locks), 0, '孤儿锁应被删除');
});

t('M-9：job/expire 不误删 checked_in 未结束场次的锁', async () => {
  seedBase();
  setNow(TODAY, '18:25'); // 18:20~19:30 进行中
  mock.seed(config.COLLECTION.student_slot_locks, {
    _id: 'stu_A_' + TODAY + '_1820_1930', student_openid: 'stu_A', date: TODAY,
    slot_key: '1820_1930', venue_key: 'badminton#1', res_id: 'ci_res', create_time: 1,
  });
  mock.seed(config.COLLECTION.reservation_records, {
    _id: 'rec_ci', res_id: 'ci_res', student_openid: 'stu_A', date: TODAY,
    slot_key: '1820_1930', status: 'checked_in', create_time: 1, update_time: 1,
  });

  await expectOk(() => new JobService().expire(), 'expire');
  assertEqual(mock.size(config.COLLECTION.student_slot_locks), 1, '进行中的 checked_in 锁不应被清');
});

/* ================= L-1：公告发布写操作日志 ================= */
t('L-1：发布公告写入 operation_logs（审计链完整）', async () => {
  seedBase();
  await expectOk(() => new NoticeService().add(userOf('adm_1'), { title: '测试公告', content: '内容' }), '发布公告');
  const logs = mock.dump(config.COLLECTION.operation_logs).filter((l) => l.action === 'add_notice');
  assertEqual(logs.length, 1, '应有 1 条 add_notice 日志');
  assertEqual(logs[0].module, 'notice', 'module 应为 notice');
});

/* ================= L-2：anti_abuse 限流记录清理 ================= */
t('L-2：job/expire 清理过期限流记录，保留未过期的', async () => {
  seedBase();
  const now = timeUtil.now();
  const dayMs = config.DAY_MS;
  mock.seed(config.COLLECTION.anti_abuse, {
    _id: 'stu_A_reservation/create_100', openid: 'stu_A', route: 'reservation/create', create_time: now - 2 * dayMs,
  });
  mock.seed(config.COLLECTION.anti_abuse, {
    _id: 'stu_A_reservation/create_200', openid: 'stu_A', route: 'reservation/create', create_time: now,
  });

  await expectOk(() => new JobService().expire(), 'expire');
  const aa = mock.dump(config.COLLECTION.anti_abuse);
  assert(aa.some((a) => a._id === 'stu_A_reservation/create_200'), '未过期限流记录应保留');
  assert(!aa.some((a) => a._id === 'stu_A_reservation/create_100'), '过期限流记录应被清理');
});

/* ================= L-4：过期 checked_in 占用清理 ================= */
t('L-4：job/expire 清理 date<=昨天 的 checked_in 占用文档（流水不动）', async () => {
  seedBase();
  const yest = timeUtil.addDays(TODAY, -1);
  mock.seed(config.COLLECTION.reservations, {
    _id: yest + '_1820_1930_badminton#1', student_openid: 'stu_A', date: yest,
    slot_key: '1820_1930', venue_key: 'badminton#1', status: 'checked_in', create_time: 1,
  });
  mock.seed(config.COLLECTION.reservation_records, {
    _id: 'rec_old_ci', res_id: yest + '_1820_1930_badminton#1', student_openid: 'stu_A',
    date: yest, slot_key: '1820_1930', status: 'checked_in', create_time: 1, update_time: 1,
  });

  const res = await expectOk(() => new JobService().expire(), 'expire');
  assert(res.stale_reservations_cleaned >= 1, '应清理过期 checked_in 占用');
  assertEqual(mock.size(config.COLLECTION.reservations), 0, '占用文档应被清理');
  assertEqual(mock.dump(config.COLLECTION.reservation_records).length, 1, '流水应保留不动');
});

/* ================= L-5：边界校验 ================= */
t('L-5：closed_until 为负数时拒绝', async () => {
  seedBase();
  await expectErr(() => new VenueService().close(userOf('sa_1'), { venue_key: 'badminton#1', closed: true, closed_until: -100 }),
    appCode.DATA, '负数 closed_until');
});

t('L-5：open_time hour=25 / minute=60 时拒绝', async () => {
  seedBase();
  await expectErr(() => new ConfigService().set(userOf('sa_1'), { key: 'open_time', value: { hour: 25, minute: 0 } }),
    appCode.DATA, 'hour=25');
  await expectErr(() => new ConfigService().set(userOf('sa_1'), { key: 'open_time', value: { hour: 21, minute: 60 } }),
    appCode.DATA, 'minute=60');
});

t('L-5：open_time 合法值正常写入', async () => {
  seedBase();
  await expectOk(() => new ConfigService().set(userOf('sa_1'), { key: 'open_time', value: { hour: 21, minute: 0 } }), '合法配置');
  const cfg = mock.dump(config.COLLECTION.configs).find((c) => c._id === 'open_time');
  assertEqual(cfg.value, { hour: 21, minute: 0 }, '配置应写入');
});

/* ================= L-6：notice/detail 裁剪 ================= */
t('L-6：notice/detail 不返回 author_openid / status', async () => {
  seedBase();
  mock.seed(config.COLLECTION.notices, {
    _id: 'n1', title: '公告', content: '内容', status: 'published',
    author_openid: 'adm_1', author_name: '管理员', publish_time: 123, update_time: 123,
  });
  const d = await expectOk(() => new NoticeService().detail('n1'), '详情');
  assertEqual(d.author_openid, undefined, '不应返回 author_openid');
  assertEqual(d.status, undefined, '不应返回 status');
  assertEqual(d.title, '公告', 'title 应保留');
  assertEqual(d.author_name, '管理员', 'author_name 供展示应保留');
});

/* ================= L-8：studentDetail 角色限制 ================= */
t('L-8：hr/studentDetail 不可查看超管/人事的 PII', async () => {
  seedBase();
  await expectErr(() => new HrService().studentDetail('hr_1'), appCode.NO_RIGHT, '查看人事详情');
  await expectErr(() => new HrService().studentDetail('sa_1'), appCode.NO_RIGHT, '查看超管详情');
  const stu = await expectOk(() => new HrService().studentDetail('stu_A'), '查看学生详情');
  assertEqual(stu.name, '张三', '学生详情应可查');
});

/* ================= M-2：定时任务触发判定收紧 ================= */
t('M-2：伪造 TriggerName（无 Type=Timer）不再触发定时任务', async () => {
  seedBase();
  mock.setOpenId('');
  // 旧实现：event.TriggerName 存在即进 runTimerJob；新实现只认 Type==='Timer'
  const res = await application.app({ TriggerName: 'gymreserve-expire' }, {});
  // 应走普通路由解析并因缺 route 报错（1301），而不是执行 job
  assert(res.code !== 200, '伪造触发应被拒绝，实际：' + JSON.stringify(res));
});

t('M-2：Type=Timer 的合法定时触发仍可执行 job', async () => {
  seedBase();
  const res = await application.app({ Type: 'Timer', TriggerName: 'gymreserve-expire' }, {});
  assertEqual(res.code, 200, '合法定时触发应放行');
});

/* ================= H-5：smoke/run 环境开关 ================= */
t('H-5：smoke/run 未开 ENABLE_SMOKE 时即使密钥正确也拒绝', async () => {
  seedBase();
  mock.setOpenId('');
  const saved = config.JOB_SECRET;
  const savedEnv = process.env.ENABLE_SMOKE;
  config.JOB_SECRET = 'test-secret';
  delete process.env.ENABLE_SMOKE;
  try {
    const res = await application.app({ route: 'smoke/run', job_secret: 'test-secret' }, {});
    assertEqual(res.code, appCode.NO_RIGHT, '未开 ENABLE_SMOKE 应拒绝');
  } finally {
    config.JOB_SECRET = saved;
    if (savedEnv === undefined) delete process.env.ENABLE_SMOKE;
    else process.env.ENABLE_SMOKE = savedEnv;
  }
});

/* ================= H-5：HTTP 入口只读白名单 ================= */
t('H-5：HTTP 通道只放行只读白名单，init/run、job/*、写接口一律 403', async () => {
  seedBase();
  const mk = (bodyObj) => ({ httpMethod: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyObj) });

  // 只读白名单放行
  const ok = await indexEntry.main(mk({ route: 'notice/list' }), {});
  assertEqual(ok.statusCode, 200, 'notice/list 应放行');

  // init/run 拒绝
  const r1 = await indexEntry.main(mk({ route: 'init/run', job_secret: 'x' }), {});
  assertEqual(r1.statusCode, 403, 'init/run 应拒绝');
  assertEqual(JSON.parse(r1.body).code, 4003, 'init/run 返回 4003');

  // job 拒绝
  const r2 = await indexEntry.main(mk({ route: 'job/expire', job_secret: 'x' }), {});
  assertEqual(r2.statusCode, 403, 'job/expire 应拒绝');

  // 写接口拒绝（即便带 openid 伪造参数）
  const r3 = await indexEntry.main(mk({ route: 'reservation/create', date: TODAY }), {});
  assertEqual(r3.statusCode, 403, 'reservation/create 应拒绝');

  // smoke 拒绝
  const r4 = await indexEntry.main(mk({ route: 'smoke/run', job_secret: 'x' }), {});
  assertEqual(r4.statusCode, 403, 'smoke/run 应拒绝');
});

/* ================= L-3：stats 聚合口径 ================= */
t('L-3：my/stats 超过 1000 条流水后口径仍正确（count 聚合）', async () => {
  seedBase();
  mock.setOpenId('stu_A');
  // 构造 1050 条 cancelled + 3 条 expired：旧实现只看 1000 条会漏计 expired
  for (let i = 0; i < 1050; i++) {
    mock.seed(config.COLLECTION.reservation_records, {
      _id: 'rc_' + i, res_id: 'rr_' + i, student_openid: 'stu_A', date: TODAY,
      slot_key: '1820_1930', status: 'cancelled', create_time: 1, update_time: 1,
    });
  }
  for (let i = 0; i < 3; i++) {
    mock.seed(config.COLLECTION.reservation_records, {
      _id: 're_' + i, res_id: 'rr_e' + i, student_openid: 'stu_A', date: TODAY,
      slot_key: '1820_1930', status: 'expired', create_time: 1, update_time: 1,
    });
  }
  const ctrl = new MyController('my/stats', 'stu_A', userOf('stu_A'), 1, {});
  const st = await expectOk(() => ctrl.stats(), 'stats');
  assertEqual(st.total_count, 3, 'cancelled 不计入，总数应为 3');
  assertEqual(st.no_show_count, 3, '爽约应为 3（旧实现截断 1000 条会得 0）');
});
