/**
 * 行为级回归测试：真实 service 代码 + 内存 mock 云数据库（test/_mock_cloud.js）。
 *
 * 01~07 只覆盖纯函数，涉及数据库的路径（create/cancel/checkin/expire/close）从未被执行过，
 * 而 P0 缺陷全在这些路径上。本文件补这部分：断言最终数据状态与错误码，而非源码里的公式。
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
const HrService = require(path.join(CF, 'project/service/hr_service.js'));
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

/** 注册用例：结束时必定恢复时钟，避免污染后续用例 */
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
  mock.seed(config.COLLECTION.users, {
    _id: 'adm_1', openid: 'adm_1', role: 2, name: '管理员', info_completed: true, status: 1,
    black_until: 0, create_time: 0, update_time: 0,
  });
  // 可选：模拟真实环境可能已建的 uniq_student_slot 唯一索引（仅作查询优化）。
  // 防重复的正确性已由 student_slot_locks 锁表（_id 主键天然唯一）兜底，不依赖此索引。
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

/* ================= 1. 预约时间窗 ================= */
t('当天已结束的场次不可预约（20:00 约 18:20~19:30）', async () => {
  seedBase();
  setNow(TODAY, '20:00');
  const e = await expectErr(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#3' }),
    appCode.NOT_OPEN_TIME, '预约已结束场次');
  assert(mock.size(config.COLLECTION.reservations) === 0, '被拒后不应留下占用记录');
  assert(/开始|结束/.test(e.message), '提示语应说明场次已开始/结束，实际：' + e.message);
});

t('当天已开始未结束的场次不可预约（20:00 约 19:40~20:50）', async () => {
  seedBase();
  setNow(TODAY, '20:00');
  await expectErr(() => book('stu_A', { date: TODAY, slot_key: '1940_2050', venue_key: 'pingpong#1' }),
    appCode.NOT_OPEN_TIME, '预约进行中的场次');
});

t('当天未开始的场次可以预约（10:00 约 18:20）', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  const r = await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1' }), '预约当天未来场次');
  assertEqual(r.res_id, TODAY + '_1820_1930_badminton#1', 'res_id 应为 日期_场次_场地');
  assertEqual(mock.size(config.COLLECTION.reservations), 1, '占用表应有 1 条');
  assertEqual(mock.size(config.COLLECTION.reservation_records), 1, '流水表应有 1 条');
});

t('开放时间边界：21:30 只能约明天，不能约今天', async () => {
  seedBase();
  setNow(TODAY, '21:30');
  await expectErr(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1' }),
    appCode.NOT_OPEN_TIME, '21:30 约今天');
  await expectOk(() => book('stu_A', { date: TOMORROW, slot_key: '1820_1930', venue_key: 'badminton#1' }), '21:30 约明天');
});

/* ================= 2. 防重复与场地占用 ================= */
t('同一学生抢自己已占的同一场地返回 4100', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#2' }), '首次预约');
  await expectErr(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#2' }),
    appCode.VENUE_TAKEN, '重复预约同一场地');
});

t('同一学生同一时间窗跨场馆约第二个场地被拦（无唯一索引下也可靠）', async () => {
  seedBase();
  mock.setUniqueIndexes([]); // 模拟「唯一索引没建」的真实部署状态（现由锁表兜底，索引非必需）
  setNow(TODAY, '10:00');
  await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1' }), '第一单');
  await expectErr(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'pingpong#1' }),
    appCode.DUPLICATE_SLOT, '同时间窗跨场馆第二单');
  assertEqual(mock.size(config.COLLECTION.student_slot_locks), 1, '应只有 1 条学生时段锁');
});

t('锁表兜底：应用层查重漏掉（签到后）时，锁主键冲突仍拦截跨场馆', async () => {
  seedBase();
  mock.setUniqueIndexes([]);
  setNow(TODAY, '10:00');
  await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1' }), '第一单');

  // 把占用记录改成 checked_in（模拟已签到），使应用层查重（status=pending）查不到；
  // 此时只有 student_slot_locks 锁表的主键冲突能兜底拦截。
  const res = mock.dump(config.COLLECTION.reservations)[0];
  mock.seed(config.COLLECTION.reservations, Object.assign({}, res, { status: 'checked_in' }));

  await expectErr(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'pingpong#1' }),
    appCode.DUPLICATE_SLOT, '锁表兜底拦截签到后再约同时段');
});

/* ================= 3. 取消与释放 ================= */
t('取消后场地可被他人重新预约', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  const a = await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#6' }), 'A 预约');
  await expectOk(() => new ReservationService().cancel('stu_A', { res_id: a.res_id }), 'A 取消');
  assertEqual(mock.size(config.COLLECTION.reservations), 0, '取消应物理删除占用');
  assertEqual(mock.size(config.COLLECTION.student_slot_locks), 0, '取消应释放学生时段锁');
  const rec = mock.dump(config.COLLECTION.reservation_records)[0];
  assertEqual(rec.status, 'cancelled', '流水应为 cancelled（保留历史）');
  await expectOk(() => book('stu_B', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#6' }), 'B 抢同一场地');
});

t('取消时间边界：17:50 拒绝（4107），17:49:59 允许', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  const late = await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'pingpong#2' }), '预约');
  setNow(TODAY, '17:50:00');
  await expectErr(() => new ReservationService().cancel('stu_A', { res_id: late.res_id }),
    appCode.CANCEL_TOO_LATE, '开始前正好 30 分钟取消');

  setNow(TODAY, '17:49:59');
  await expectOk(() => new ReservationService().cancel('stu_A', { res_id: late.res_id }), '开始前 30 分零 1 秒取消');
});

/* ================= 4. 爽约扫描 ================= */
t('爽约扫描：流水 expired + 释放占用 + 自动拉黑 10 天', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#4' }), '预约');
  assertEqual(mock.size(config.COLLECTION.reservations), 1, '预约后应有 1 条占用');

  setNow(TODAY, '19:31'); // 场次已结束且未签到
  const job = await expectOk(() => new JobService().expire(), '爽约扫描');

  const recs = mock.dump(config.COLLECTION.reservation_records);
  assertEqual(recs.length, 1, '流水数');
  assertEqual(recs[0].status, 'expired', '流水状态应为 expired');

  // 关键：占用必须被释放，否则该场地会永久显示「已约」（原缺陷即此处删错主键）
  assertEqual(mock.size(config.COLLECTION.reservations), 0, '爽约后占用应被释放');
  assertEqual(mock.size(config.COLLECTION.student_slot_locks), 0, '爽约后学生时段锁应被释放');
  const st = await expectOk(() => new ReservationService().status(
    { date: TODAY, slot_key: '1820_1930', venue_type: 'badminton' }), '查询场地状态');
  const court = st.find((v) => v.venue_key === 'badminton#4');
  assert(court, '应能查到 badminton#4');
  assertEqual(court.status, 'available', '爽约处理后该场地应恢复 available');

  const bl = mock.dump(config.COLLECTION.blacklist);
  assertEqual(bl.length, 1, '应产生 1 条黑名单');
  assertEqual(bl[0].channel, 'auto', '应为自动拉黑');
  const u = userOf('stu_A');
  assertEqual(u.black_until, fakeNow + config.AUTO_BLACK_DAYS * 86400000, '拉黑应到 now + 10 天');
  assertEqual(job.processed, 1, 'job 应统计到 1 条');
});

t('被闭馆取消的预约，当晚不会再被判爽约拉黑', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#5' }), '预约');
  const closeRes = await expectOk(() => new VenueService().close(userOf('adm_1'),
    { venue_key: 'badminton#5', closed: true, closed_until: 0 }), '闭馆');
  assertEqual(closeRes.cancelled_bookings, 1, '闭馆应联动取消 1 条预约');
  assertEqual(mock.size(config.COLLECTION.student_slot_locks), 0, '闭馆取消应释放学生时段锁');

  setNow(TODAY, '19:31');
  await expectOk(() => new JobService().expire(), '当晚爽约扫描');
  const recs = mock.dump(config.COLLECTION.reservation_records);
  assertEqual(recs[0].status, 'cancelled', '流水应保持 cancelled');
  assertEqual(mock.dump(config.COLLECTION.blacklist).length, 0, '不得误拉黑学生');
});

/* ================= 5. 鉴权 ================= */
t('不带 job_secret 直接调 job/expire 路由返回 4003', async () => {
  seedBase();
  mock.setOpenId('stu_A');
  setNow(TODAY, '12:00');
  const res = await application.app({ route: 'job/expire' }, {});
  assertEqual(res.code, appCode.NO_RIGHT, '应拒绝越权调用');
});

/* ================= 6. 签到链路 ================= */
t('二维码 → 扫码 → 签到（含 1 名附属人员），重复签到幂等', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  await expectOk(() => book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'gym#7' }), '预约');

  mock.setOpenId('stu_A');
  setNow(TODAY, '18:06'); // 签到窗口：开始前 15 分钟内
  const gen = await application.app({ route: 'qrcode/generate' }, {});
  assertEqual(gen.code, 200, '生成二维码应成功');
  const token = gen.data.token;
  assert(token, '应返回 token');

  mock.setOpenId('adm_1');
  const scan = await application.app({ route: 'admin/scan', token: token }, {});
  assertEqual(scan.code, 200, '扫码应成功');
  const resId = scan.data.booking.res_id;

  const ci = await application.app({ route: 'admin/checkin', res_id: resId, slot_key: '1820_1930', companions: ['李四'] }, {});
  assertEqual(ci.code, 200, '签到应成功');

  assertEqual(mock.dump(config.COLLECTION.reservations)[0].status, 'checked_in', '占用状态');
  assertEqual(mock.dump(config.COLLECTION.reservation_records)[0].status, 'checked_in', '流水状态');
  const cr = mock.dump(config.COLLECTION.checkin_records);
  assertEqual(cr.length, 1, '签到记录应落库');
  assertEqual(cr[0].companions.length, 1, '附属人员应落库');

  const ci2 = await application.app({ route: 'admin/checkin', res_id: resId, slot_key: '1820_1930' }, {});
  assertEqual(ci2.code, 200, '重复签到不应报错');
  assertEqual(ci2.data.already, true, '重复签到应返回 already=true');
});

/* ================= 7. 其他已知边界 ================= */
t('人事搜索关键字含正则元字符不抛异常', async () => {
  seedBase();
  for (const kw of ['(', '.*']) {
    const r = await expectOk(() => new HrService().studentList({ keyword: kw, page: 1, size: 20 }), '搜索 "' + kw + '"');
    assert(Array.isArray(r.list), '应返回列表结构');
  }
});

t('人事撤销管理员：不能操作同级或更高权限的成员', async () => {
  seedBase();
  const mk = (id, role, name) => mock.seed(config.COLLECTION.users, {
    _id: id, openid: id, role: role, name: name, status: 1, black_until: 0,
  });
  mk('hr_1', config.ROLE.HR_ADMIN, '王人事');
  mk('hr_2', config.ROLE.HR_ADMIN, '孙人事');
  mk('sa_1', config.ROLE.SUPER_ADMIN, '赵超管');
  mk('sa_2', config.ROLE.SUPER_ADMIN, '钱超管');
  mk('adm_2', config.ROLE.ADMIN, '孙管理员');
  const svc = new HrService();

  // 人事管理员(4) 不能移除同级人事管理员(4)
  await expectErr(() => svc.adminRemove(userOf('hr_1'), { openid: 'hr_2' }),
    appCode.NO_RIGHT, '人事管理员移除同级人事管理员');
  assertEqual(userOf('hr_2').role, config.ROLE.HR_ADMIN, '被拒后角色不应变化');
  // 超管(3) 不能移除更高权限的人事管理员(4)
  await expectErr(() => svc.adminRemove(userOf('sa_1'), { openid: 'hr_1' }),
    appCode.NO_RIGHT, '超管移除人事管理员');
  // 超管(3) 不能移除同级超管(3)
  await expectErr(() => svc.adminRemove(userOf('sa_1'), { openid: 'sa_2' }),
    appCode.NO_RIGHT, '超管移除同级超管');
  // 向下操作正常：人事管理员(4) 可移除超管(3)、普通管理员(2)
  await expectOk(() => svc.adminRemove(userOf('hr_1'), { openid: 'sa_1' }), '人事管理员移除超管');
  assertEqual(userOf('sa_1').role, config.ROLE.STUDENT, '超管应被降为学生');
  await expectOk(() => svc.adminRemove(userOf('hr_1'), { openid: 'adm_2' }), '人事管理员移除普通管理员');
});

t('任命权限：超管只能任命普通管理员', async () => {
  seedBase();
  const mk = (id, role, name) => mock.seed(config.COLLECTION.users, {
    _id: id, openid: id, role: role, name: name, status: 1, black_until: 0,
  });
  mk('sa_1', config.ROLE.SUPER_ADMIN, '赵超管');
  const svc = new HrService();
  const op = () => userOf('sa_1');

  // 超管(3) 能任命普通管理员(2)
  await expectOk(() => svc.adminAdd(op(), { openid: 'new_adm', role: config.ROLE.ADMIN, name: '新管理员' }),
    '超管任命普通管理员');
  assertEqual(userOf('new_adm').role, config.ROLE.ADMIN, '任命后角色应为普通管理员');

  // 超管(3) 不能任命超管(3)
  await expectErr(() => svc.adminAdd(op(), { openid: 'new_sa', role: config.ROLE.SUPER_ADMIN, name: '新超管' }),
    appCode.NO_RIGHT, '超管任命超管');

  // 超管(3) 不能任命人事管理员(4)
  await expectErr(() => svc.adminAdd(op(), { openid: 'new_hr', role: config.ROLE.HR_ADMIN, name: '新人事' }),
    appCode.NO_RIGHT, '超管任命人事管理员');
});

t('任命权限：人事管理员可任命到人事管理员和超管', async () => {
  seedBase();
  const mk = (id, role, name) => mock.seed(config.COLLECTION.users, {
    _id: id, openid: id, role: role, name: name, status: 1, black_until: 0,
  });
  mk('hr_1', config.ROLE.HR_ADMIN, '王人事');
  const svc = new HrService();

  // 人事管理员(4) 能任命：普通管理员(2)、超管(3)、人事管理员(4)
  await expectOk(() => svc.adminAdd(userOf('hr_1'), { openid: 'a1', role: config.ROLE.ADMIN, name: 'a1' }),
    '人事管理员任命普通管理员');
  await expectOk(() => svc.adminAdd(userOf('hr_1'), { openid: 'a2', role: config.ROLE.SUPER_ADMIN, name: 'a2' }),
    '人事管理员任命超管');
  await expectOk(() => svc.adminAdd(userOf('hr_1'), { openid: 'a3', role: config.ROLE.HR_ADMIN, name: 'a3' }),
    '人事管理员任命人事管理员');
});

t('任命权限：学生/普通管理员无权任命', async () => {
  seedBase();
  const mk = (id, role, name) => mock.seed(config.COLLECTION.users, {
    _id: id, openid: id, role: role, name: name, status: 1, black_until: 0,
  });
  mk('stu_x', config.ROLE.STUDENT, '学生');
  mk('adm_x', config.ROLE.ADMIN, '普通管理员');
  const svc = new HrService();

  // 学生(1)、普通管理员(2) 都无权任命（assignableRoles 返回空数组 → NO_RIGHT）
  await expectErr(() => svc.adminAdd(userOf('stu_x'), { openid: 't1', role: config.ROLE.ADMIN, name: 't1' }),
    appCode.NO_RIGHT, '学生任命管理员');
  await expectErr(() => svc.adminAdd(userOf('adm_x'), { openid: 't2', role: config.ROLE.ADMIN, name: 't2' }),
    appCode.NO_RIGHT, '普通管理员任命管理员');
});

t('adminAssign 与 adminAdd 使用同一套任命权限规则', async () => {
  seedBase();
  const mk = (id, role, name) => mock.seed(config.COLLECTION.users, {
    _id: id, openid: id, role: role, name: name, status: 1, black_until: 0,
  });
  mk('sa_1', config.ROLE.SUPER_ADMIN, '赵超管');
  mk('hr_1', config.ROLE.HR_ADMIN, '王人事');
  mk('target', config.ROLE.ADMIN, '目标管理员');
  const svc = new HrService();

  // 超管通过 adminAssign 把目标调成超管 → 应被拒（超管不能任命超管）
  await expectErr(() => svc.adminAssign(userOf('sa_1'), { openid: 'target', role: config.ROLE.SUPER_ADMIN, status: 1 }),
    appCode.NO_RIGHT, '超管 assign 超管');
  // 人事管理员通过 adminAssign 把目标调成超管 → 应成功（人事管理员可任命超管）
  await expectOk(() => svc.adminAssign(userOf('hr_1'), { openid: 'target', role: config.ROLE.SUPER_ADMIN, status: 1 }),
    '人事管理员 assign 超管');
  assertEqual(userOf('target').role, config.ROLE.SUPER_ADMIN, 'assign 后目标应为超管');
});

t('init/run 明确标记：唯一索引非必需（防重复已由锁表兜底）', async () => {
  mock.reset();
  const r = await expectOk(() => initData.initAll(), 'init');
  // 锁表兜底后，uniq_student_slot 仅作可选查询优化，不再要求手动建索引；
  // 这里锁住「降级时必须显式告知非必需」的行为，避免有人误以为仍需手动建索引。
  const idx = r.indexes || [];
  assert(idx.some((n) => String(n).indexOf('optional') >= 0),
    '锁表兜底后唯一索引应标记为可选，实际：' + JSON.stringify(idx));
  const note = String(r.note || '');
  assert(/锁表|student_slot_locks/.test(note),
    'note 应说明防重复已由锁表兜底，实际：' + note);
});

t('initVenues 幂等补齐缺失场馆（已有部分场馆时重跑仍能补出健身房）', async () => {
  mock.reset();
  // 模拟「旧版/中断只建了 badminton#1，其余 31 个场地缺失」的部署状态；
  // 且 badminton#1 处于「闭馆」运营态，用于验证补齐全不会覆盖已有场地的运营状态
  mock.seed(config.COLLECTION.venues, {
    _id: 'badminton#1', venue_key: 'badminton#1', venue_type: 'badminton',
    venue_type_name: '羽毛球场', court_no: 1, closed: true, closed_until: 9999999999999, update_time: 0,
  });
  const r = await initData.initVenues();
  assertEqual(r.created, 31, '应补齐缺失的 31 个场地');
  assertEqual(mock.size(config.COLLECTION.venues), 32, '补齐后应共 32 个场地');
  const gym = mock.dump(config.COLLECTION.venues).filter((v) => v.venue_type === 'gym');
  assertEqual(gym.length, 20, '健身房应有 20 个场地');
  // 已存在的场地不被覆盖（闭馆运营状态应保留，而非被重置为默认 closed:false）
  const b1 = mock.dump(config.COLLECTION.venues).find((v) => v.venue_key === 'badminton#1');
  assertEqual(b1.closed, true, '已存在场地的 closed 状态应保留');
  assertEqual(b1.closed_until, 9999999999999, '已存在场地的 closed_until 应保留');
});
