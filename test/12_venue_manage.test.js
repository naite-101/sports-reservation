/**
 * 12_venue_manage：场地管理（我的 → 管理后台 → 场地管理）增量功能测试
 *
 * 覆盖：
 *  1) 权限：普通用户访问场地管理接口被拒（4003），管理员可用；
 *  2) 后台签到：不扫码直接签到、幂等、窗口校验；
 *  3) 拉黑：拉黑后后台签到与扫码签到链路同时被拦（4004）；
 *  4) 信息查看：列表返回主签到人 + 附属人员基础信息；
 *  5) 补录：晚到附属人员后台追加、重名拦截、删除补录；
 *  6) 列表区分：主签到 / 随行人员(onsite) / 后台补录(admin)。
 */
const path = require('path');
const fs = require('fs');
const { test, assert, assertEqual } = require('./_lib.js');
const mock = require('./_mock_cloud.js');

const ROOT = path.resolve(__dirname, '..');
const CF = path.join(ROOT, 'cloudfunctions', 'cloud');

const config = require(path.join(CF, 'config/config.js'));
const timeUtil = require(path.join(CF, 'framework/utils/time_util.js'));
const appCode = require(path.join(CF, 'framework/core/app_code.js'));
const ReservationService = require(path.join(CF, 'project/service/reservation_service.js'));
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
        _id: key,
        venue_key: key,
        venue_type: type,
        venue_type_name: info.name,
        court_no: i,
        closed: false,
        closed_until: 0,
        update_time: 0,
      });
    }
  }
  mock.seed(config.COLLECTION.configs, {
    _id: 'open_time',
    key: 'open_time',
    value: config.DEFAULT_OPEN_TIME,
  });

  const student = (id, name, no, phone) =>
    mock.seed(config.COLLECTION.users, {
      _id: id,
      openid: id,
      role: 1,
      name: name,
      student_no: no,
      phone: phone,
      college: '机械学院',
      info_completed: true,
      status: 1,
      black_until: 0,
      create_time: 0,
      update_time: 0,
    });
  student('stu_A', '张三', '2023001', '13800000000');
  student('stu_B', '李四', '2023002', '13800000001');
  student('stu_C', '王五', '2023003', '13800000002');

  mock.seed(config.COLLECTION.users, {
    _id: 'adm_1',
    openid: 'adm_1',
    role: 2,
    name: '管理员甲',
    info_completed: true,
    status: 1,
    black_until: 0,
    create_time: 0,
    update_time: 0,
  });
}

function userOf(id) {
  return mock.dump(config.COLLECTION.users).filter((u) => u._id === id)[0];
}

async function book(openid, opts) {
  return await new ReservationService().create(openid, userOf(openid), opts);
}

/** 以某学生身份生成「个人二维码」token（20 秒有效），用于扫码补录用例 */
async function qrToken(openid) {
  mock.setOpenId(openid);
  const r = await call('qrcode/generate');
  assertEqual(r.code, 200, openid + ' 生成个人二维码');
  return r.data.token;
}

function call(route, data) {
  return application.app(Object.assign({ route: route }, data || {}), {});
}

function recOf(openid) {
  return mock.dump(config.COLLECTION.checkin_records).filter((r) => r.student_openid === openid)[0];
}

function userAfter(openid) {
  return mock.dump(config.COLLECTION.users).filter((u) => u._id === openid)[0];
}

/* ================= 1. 权限 ================= */
t('场地管理：普通用户无权限（4003），管理员可用', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  mock.setOpenId('stu_A');
  const deny = await call('venue_manage/checkin_list');
  assertEqual(deny.code, appCode.NO_RIGHT, '普通用户应被拒绝');

  mock.setOpenId('adm_1');
  const ok = await call('venue_manage/checkin_list');
  assertEqual(ok.code, 200, '管理员应放行');
  assertEqual(ok.data.list.length, 0, '初始无签到记录');
});

/* ================= 2. 后台签到 ================= */
t('后台签到：管理员不扫码直接为用户签到，重复签到幂等', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  const b = await book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#1' });

  setNow(TODAY, '18:06');
  mock.setOpenId('adm_1');

  const pending = await call('venue_manage/pending_list');
  assertEqual(pending.code, 200);
  assertEqual(pending.data.list.length, 1, '应列出 1 条待签到预约');
  assertEqual(pending.data.list[0].can_checkin, true, '窗口内应可签到');
  assertEqual(pending.data.list[0].student_name, '张三');

  const r = await call('venue_manage/checkin', { res_id: b.res_id, slot_key: '1820_1930' });
  assertEqual(r.code, 200, '后台签到应成功');
  assertEqual(mock.dump(config.COLLECTION.reservations)[0].status, 'checked_in', '预约应置为已签到');
  assertEqual(mock.size(config.COLLECTION.checkin_records), 1, '签到记录应落库');
  assertEqual(mock.dump(config.COLLECTION.checkin_records)[0].admin_name, '管理员甲', '应记录操作管理员');

  const again = await call('venue_manage/checkin', { res_id: b.res_id });
  assertEqual(again.code, 200, '重复签到不报错');
  assertEqual(again.data.already, true, '重复签到应返回 already');

  const after = await call('venue_manage/pending_list');
  assertEqual(after.data.list.length, 0, '已签到的预约不再出现在待签到列表');
});

t('后台签到：未到窗口 / 场次结束后均不可签到', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  const b = await book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'gym#2' });
  mock.setOpenId('adm_1');

  const early = await call('venue_manage/pending_list');
  assertEqual(early.data.list[0].can_checkin, false, '未到窗口不应可签到');
  assertEqual(early.data.list[0].state, 'too_early');
  const r1 = await call('venue_manage/checkin', { res_id: b.res_id });
  assertEqual(r1.code, appCode.LOGIC, '未到窗口应报逻辑错误');

  setNow(TODAY, '19:31');
  const ended = await call('venue_manage/pending_list');
  assertEqual(ended.data.list[0].can_checkin, false, '场次结束后不应可签到');
  assertEqual(ended.data.list[0].state, 'ended');
  const r2 = await call('venue_manage/checkin', { res_id: b.res_id });
  assertEqual(r2.code, appCode.LOGIC, '场次结束后应报逻辑错误');
});

/* ================= 3. 拉黑 ================= */
t('拉黑后无法签到：后台签到与扫码确认链路同时拦截', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  const b1 = await book('stu_B', { date: TODAY, slot_key: '1820_1930', venue_key: 'pingpong#1' });
  const b2 = await book('stu_B', { date: TODAY, slot_key: '1940_2050', venue_key: 'gym#1' });

  setNow(TODAY, '18:06');
  mock.setOpenId('adm_1');
  const ci = await call('venue_manage/checkin', { res_id: b1.res_id });
  assertEqual(ci.code, 200, '首场签到应成功');
  const rec = recOf('stu_B');

  const blocked = await call('venue_manage/block_user', {
    checkin_id: rec._id,
    duration_days: 3,
    reason: '测试拉黑',
  });
  assertEqual(blocked.code, 200, '拉黑应成功');
  assertEqual(blocked.data.duration_days, 3);
  assert(userAfter('stu_B').black_until > Date.now(), 'users.black_until 应同步');

  const pending = await call('venue_manage/pending_list');
  assertEqual(pending.data.list.length, 1, '应只剩第二场待签到');
  assertEqual(pending.data.list[0].can_checkin, false, '被拉黑用户应不可签到');
  assertEqual(pending.data.list[0].state, 'blocked');

  setNow(TODAY, '19:26'); // 第二场窗口内（19:25 起可签），用于验证拦截来自黑名单而非窗口
  const r1 = await call('venue_manage/checkin', { res_id: b2.res_id });
  assertEqual(r1.code, appCode.BLACKLIST, '后台签到应被黑名单拦截');

  // 扫码签到最终也走 admin/checkin -> CheckinService.checkin，同样应被拦截
  const r2 = await call('admin/checkin', { res_id: b2.res_id, slot_key: '1940_2050' });
  assertEqual(r2.code, appCode.BLACKLIST, '扫码确认签到应被黑名单拦截');

  const dup = await call('venue_manage/block_user', { checkin_id: rec._id, duration_days: 7 });
  assertEqual(dup.code, appCode.BLACKLIST, '重复拉黑应提示已在黑名单');
});

t('拉黑签到用户：按签到记录定位，列表显示已拉黑', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  const b = await book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#2' });

  setNow(TODAY, '18:06');
  mock.setOpenId('adm_1');
  const ci = await call('venue_manage/checkin', { res_id: b.res_id });
  assertEqual(ci.code, 200);

  const rec = recOf('stu_A');
  const r = await call('venue_manage/block_user', { checkin_id: rec._id, duration_days: 10, reason: '冒名签到' });
  assertEqual(r.code, 200, '按签到记录拉黑应成功');
  assertEqual(r.data.student_name, '张三');

  const list = await call('venue_manage/checkin_list');
  assertEqual(list.data.list[0].main.is_blacklisted, true, '列表应标记已拉黑');
  assert(list.data.list[0].main.black_until_text, '应返回拉黑到期日期');
  assertEqual(mock.dump(config.COLLECTION.blacklist)[0].channel, 'manual', '应写入手动拉黑记录');
});

/* ================= 4. 信息查看 ================= */
t('信息查看：列表返回主签到人与附属人员基础信息，支持场馆筛选', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  await book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#3' });
  await book('stu_B', { date: TODAY, slot_key: '1820_1930', venue_key: 'gym#8' });

  setNow(TODAY, '18:06');
  mock.setOpenId('adm_1');
  const ciA = await call('venue_manage/checkin', { res_id: TODAY + '_1820_1930_badminton#3' });
  const ciB = await call('venue_manage/checkin', { res_id: TODAY + '_1820_1930_gym#8' });
  assertEqual(ciA.code, 200, '张三签到应成功');
  assertEqual(ciB.code, 200, '李四签到应成功');

  const listA = await call('venue_manage/checkin_list');
  const a = listA.data.list.filter((x) => x.main.openid === 'stu_A')[0];
  const b = listA.data.list.filter((x) => x.main.openid === 'stu_B')[0];
  assertEqual(a.main.phone, '13800000000', '应带出手机号');
  assertEqual(a.main.college, '机械学院', '应带出学院');
  assertEqual(b.main.student_no, '2023002', '应带出学号');
  assertEqual(a.venue_text, '羽毛球场 3 号', '场馆文案应正确');
  assertEqual(a.slot_text, '18:20~19:30', '场次文案应正确');

  const filtered = await call('venue_manage/checkin_list', { venue_type: 'gym' });
  assertEqual(filtered.data.list.length, 1, '场馆筛选应只留健身房');
  assertEqual(filtered.data.list[0].main.openid, 'stu_B');

  const other = await call('venue_manage/checkin_list', { date: TOMORROW });
  assertEqual(other.data.list.length, 0, '其它日期应为空');
  assertEqual(other.data.stats.total, 0);
});

/* ================= 5. 附属人员扫码补录 ================= */
t('附属人员补录：扫对方个人二维码直接识别，列表区分随行/后台补录', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  const b = await book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#4' });

  setNow(TODAY, '18:06');
  mock.setOpenId('adm_1');
  const ci = await call('admin/checkin', {
    res_id: b.res_id,
    slot_key: '1820_1930',
    companions: [{ name: '李四', phone: '13900000001' }],
  });
  assertEqual(ci.code, 200, '主签到应成功');
  const rec = recOf('stu_A');
  assertEqual(rec.companions.length, 1, '现场随行人员应保存在原签到记录');

  setNow(TODAY, '18:40');
  const token = await qrToken('stu_C');
  mock.setOpenId('adm_1');
  const add = await call('venue_manage/companion_scan', { checkin_id: rec._id, token: token });
  assertEqual(add.code, 200, '扫附属人员二维码应补录成功');
  assertEqual(add.data.name, '王五', '应识别出扫码人姓名');
  assertEqual(add.data.student_no, '2023003', '应识别出学号');
  assertEqual(mock.size(config.COLLECTION.checkin_companions), 1, '补录应写入新集合');

  const saved = mock.dump(config.COLLECTION.checkin_companions)[0];
  assertEqual(saved.companion_openid, 'stu_C', '应记录扫码人 openid');
  assertEqual(saved.add_method, 'scan', '应标记为扫码补录');
  assertEqual(mock.dump(config.COLLECTION.checkin_records)[0].companions.length, 1, '不得改动原签到记录');

  const list = await call('venue_manage/checkin_list');
  const item = list.data.list[0];
  assertEqual(item.main.name, '张三', '主签到人应独立返回');
  assertEqual(item.companions.length, 2, '列表应合并现场随行与扫码补录');
  const onsite = item.companions.filter((c) => c.source === 'onsite');
  const admin = item.companions.filter((c) => c.source === 'admin');
  assertEqual(onsite.length, 1, '随行人员来源应为 onsite');
  assertEqual(onsite[0].source_text, '随行人员');
  assertEqual(onsite[0].student_no, '', '现场随行人员无系统学号');
  assertEqual(admin.length, 1, '扫码补录来源应为 admin');
  assertEqual(admin[0].source_text, '后台补录');
  assertEqual(admin[0].name, '王五');
  assertEqual(admin[0].student_no, '2023003', '补录人员应带出学号');
  assertEqual(admin[0].phone, '13800000002', '补录人员应带出手机号');
  assertEqual(item.admin_count, 1, '后台补录计数');
  assertEqual(list.data.stats.admin, 1, '统计应计入后台补录');
  assertEqual(list.data.stats.onsite, 1, '统计应计入随行人员');
  assertEqual(list.data.stats.total, 3, '合计人次 = 主签到 + 随行 + 补录');
});

t('扫码补录：重复扫码、主签到人本人、过期码、拉黑用户均被拦截', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  const b = await book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#5' });
  setNow(TODAY, '18:06');
  mock.setOpenId('adm_1');
  await call('admin/checkin', { res_id: b.res_id, slot_key: '1820_1930' });
  const rec = recOf('stu_A');

  // 1) 同一人重复扫码
  const tC = await qrToken('stu_C');
  mock.setOpenId('adm_1');
  const first = await call('venue_manage/companion_scan', { checkin_id: rec._id, token: tC });
  assertEqual(first.code, 200);
  const dup = await call('venue_manage/companion_scan', { checkin_id: rec._id, token: tC });
  assertEqual(dup.code, appCode.LOGIC, '重复扫码应被拦截');

  // 2) 扫到主签到人本人
  const tA = await qrToken('stu_A');
  mock.setOpenId('adm_1');
  const self = await call('venue_manage/companion_scan', { checkin_id: rec._id, token: tA });
  assertEqual(self.code, appCode.LOGIC, '主签到人本人不应作为附属补录');
  assert(/主签到人/.test(self.msg), '提示应说明是主签到人本人');

  // 3) 二维码超过 20 秒
  const tB = await qrToken('stu_B');
  mock.setOpenId('adm_1');
  setNow(TODAY, '18:06:21');
  const expired = await call('venue_manage/companion_scan', { checkin_id: rec._id, token: tB });
  assertEqual(expired.code, appCode.QR_EXPIRED, '过期码应返回 4103');

  // 4) 非签到二维码
  const bad = await call('venue_manage/companion_scan', { checkin_id: rec._id, token: 'not-a-token' });
  assertEqual(bad.code, appCode.DATA, '非签到码应提示无法识别');

  // 5) 拉黑用户：先生成二维码，再被拉黑（模拟 20 秒内状态变化）
  const tB2 = await qrToken('stu_B');
  const before = userAfter('stu_B');
  mock.seed(config.COLLECTION.users, Object.assign({}, before, { black_until: Date.now() + config.DAY_MS }));
  mock.setOpenId('adm_1');
  const blocked = await call('venue_manage/companion_scan', { checkin_id: rec._id, token: tB2 });
  assertEqual(blocked.code, appCode.BLACKLIST, '被拉黑用户不应作为附属补录');
  assertEqual(blocked.data.black_days, 1, '应返回剩余天数');
});

t('扫码补录：可删除后台补录，现场随行不可删', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  const b = await book('stu_A', { date: TODAY, slot_key: '1820_1930', venue_key: 'badminton#6' });
  setNow(TODAY, '18:06');
  mock.setOpenId('adm_1');
  await call('admin/checkin', {
    res_id: b.res_id,
    slot_key: '1820_1930',
    companions: [{ name: '李四', phone: '' }],
  });
  const rec = recOf('stu_A');

  const token = await qrToken('stu_C');
  mock.setOpenId('adm_1');
  const add = await call('venue_manage/companion_scan', { checkin_id: rec._id, token: token });
  assertEqual(add.code, 200);

  const added = mock.dump(config.COLLECTION.checkin_companions)[0];
  const rm = await call('venue_manage/companion_remove', { companion_id: added._id });
  assertEqual(rm.code, 200, '删除后台补录应成功');
  assertEqual(mock.size(config.COLLECTION.checkin_companions), 0);

  const rmOnsite = await call('venue_manage/companion_remove', { companion_id: 'onsite_' + rec._id + '_0' });
  assertEqual(rmOnsite.code, appCode.LOGIC, '不允许删除原签到记录中的随行人员');
});

/* ================= 6. 边界 ================= */
t('场地管理：不存在的预约/签到记录给出明确错误', async () => {
  seedBase();
  setNow(TODAY, '18:06');
  mock.setOpenId('adm_1');

  const r1 = await call('venue_manage/checkin', { res_id: 'not-exist' });
  assertEqual(r1.code, appCode.NO_VALID_BOOKING, '预约不存在应返回 4104');

  const token = await qrToken('stu_C');
  mock.setOpenId('adm_1');
  const r2 = await call('venue_manage/companion_scan', { checkin_id: 'not-exist', token: token });
  assertEqual(r2.code, appCode.NO_VALID_BOOKING, '签到记录不存在应返回 4104');

  const r21 = await call('venue_manage/companion_scan', { checkin_id: 'not-exist' });
  assertEqual(r21.code, appCode.DATA, '缺少二维码内容应参数校验失败');

  const r3 = await call('venue_manage/block_user', { checkin_id: 'not-exist' });
  assertEqual(r3.code, appCode.NO_VALID_BOOKING, '按不存在签到记录拉黑应返回 4104');
});

t('场地管理：签到后原签到记录仍保持既有结构（向后兼容）', async () => {
  seedBase();
  setNow(TODAY, '10:00');
  const b = await book('stu_A', { date: TODAY, slot_key: '1940_2050', venue_key: 'gym#9' });
  setNow(TODAY, '19:25');
  mock.setOpenId('adm_1');

  const r = await call('venue_manage/checkin', { res_id: b.res_id });
  assertEqual(r.code, 200);

  const rec = mock.dump(config.COLLECTION.checkin_records)[0];
  assertEqual(rec._id, b.res_id, '既有主键 _id=res_id 不变');
  assertEqual(rec.student_name, '张三');
  assertEqual(Array.isArray(rec.companions), true);
  assertEqual(rec.companions.length, 0);
  assertEqual(mock.dump(config.COLLECTION.reservation_records)[0].status, 'checked_in', '原有流水表同步');
});

/* ================= 7. 入口与页面注册 ================= */
t('场地管理：页面已注册，管理后台入口存在且页面有权限兜底', async () => {
  const mp = path.join(ROOT, 'miniprogram');
  const appJson = JSON.parse(fs.readFileSync(path.join(mp, 'app.json'), 'utf8'));
  assert(
    appJson.pages.indexOf('pages/admin/venue-manage/venue-manage') >= 0,
    'app.json 需注册场地管理页面'
  );

  const adminWxml = fs.readFileSync(path.join(mp, 'pages/admin/admin.wxml'), 'utf8');
  assert(
    adminWxml.indexOf('/pages/admin/venue-manage/venue-manage') >= 0,
    '管理后台需有「场地管理」入口'
  );

  const pageJs = fs.readFileSync(path.join(mp, 'pages/admin/venue-manage/venue-manage.js'), 'utf8');
  assert(pageJs.indexOf('role < 2') >= 0, '页面需保留非管理员兜底拦截');
});
