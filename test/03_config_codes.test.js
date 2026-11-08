/**
 * 配置常量 / 错误码 / 初始化数据 一致性测试（加载真实 config / app_code / init_data）
 */
const path = require('path');
const { test, assert, assertEqual } = require('./_lib.js');

const config = require(path.resolve(__dirname, '../cloudfunctions/cloud/config/config.js'));
const appCode = require(path.resolve(__dirname, '../cloudfunctions/cloud/framework/core/app_code.js'));
const initData = require(path.resolve(__dirname, '../cloudfunctions/cloud/project/init/init_data.js'));
const timeUtil = require(path.resolve(__dirname, '../cloudfunctions/cloud/framework/utils/time_util.js'));

test('错误码与 ARCHITECTURE §9.2 一致', () => {
  assertEqual(appCode.SUCC, 200);
  assertEqual(appCode.SVR, 500);
  assertEqual(appCode.DATA, 1301);
  assertEqual(appCode.LOGIC, 1600);
  assertEqual(appCode.NO_LOGIN, 4001);
  assertEqual(appCode.NO_RIGHT, 4003);
  assertEqual(appCode.BLACKLIST, 4004);
  assertEqual(appCode.NO_PROFILE, 4010);
  assertEqual(appCode.VENUE_TAKEN, 4100);
  assertEqual(appCode.DUPLICATE_SLOT, 4101);
  assertEqual(appCode.NOT_OPEN_TIME, 4102);
  assertEqual(appCode.QR_EXPIRED, 4103);
  assertEqual(appCode.NO_VALID_BOOKING, 4104);
  assertEqual(appCode.SLOT_MISMATCH, 4105);
  assertEqual(appCode.VENUE_CLOSED, 4106);
  assertEqual(appCode.CANCEL_TOO_LATE, 4107);
  assertEqual(appCode.TOO_FREQUENT, 4203);
});

test('角色常量与架构一致（老师/主席已合并为人事管理员 HR_ADMIN=4）', () => {
  assertEqual(config.ROLE.ANONYMOUS, 0);
  assertEqual(config.ROLE.STUDENT, 1);
  assertEqual(config.ROLE.ADMIN, 2);
  assertEqual(config.ROLE.SUPER_ADMIN, 3);
  assertEqual(config.ROLE.HR_ADMIN, 4);
  assertEqual(config.ROLE.TEACHER, undefined, 'TEACHER 应已删除（合并进 HR_ADMIN）');
  assertEqual(config.ROLE.CHAIRMAN, undefined, 'CHAIRMAN 应已删除（合并进 HR_ADMIN）');
});

test('业务常量：二维码 20s / 爽约 10 天 / 签到前 15 分钟 / 开放 21:00', () => {
  assertEqual(config.QR_TOKEN_EXPIRE, 20000);
  assertEqual(config.AUTO_BLACK_DAYS, 10);
  assertEqual(config.CHECKIN_BEFORE_MIN, 15);
  assertEqual(config.DEFAULT_OPEN_TIME, { hour: 21, minute: 0 });
});

test('防脚本配置：预约/取消/二维码等写接口窗口冷却限流（无感人机验证替代）', () => {
  assertEqual(config.RATE_LIMIT['reservation/create'], 3000);
  assertEqual(config.RATE_LIMIT['reservation/cancel'], 3000);
  assertEqual(config.RATE_LIMIT['qrcode/generate'], 2000);
  assertEqual(config.COLLECTION.anti_abuse, 'anti_abuse');
});

test('场馆配置：羽毛球6/乒乓球6/健身房20', () => {
  assertEqual(config.VENUE_TYPES.badminton.count, 6);
  assertEqual(config.VENUE_TYPES.pingpong.count, 6);
  assertEqual(config.VENUE_TYPES.gym.count, 20);
  assertEqual(config.VENUE_TYPES.badminton.name, '羽毛球场');
  assertEqual(config.VENUE_TYPES.pingpong.name, '乒乓球场');
  assertEqual(config.VENUE_TYPES.gym.name, '健身房');
});

test('场次模板 6 条，分钟数与 parseSlotKey 交叉一致', () => {
  assertEqual(initData.TIME_SLOTS.length, 6);
  const expectedDayType = ['weekend', 'weekend', 'weekend', 'weekend', 'all', 'all'];
  initData.TIME_SLOTS.forEach((s, i) => {
    assertEqual(s.day_type, expectedDayType[i], '第 ' + i + ' 条 day_type 错误');
    const parsed = timeUtil.parseSlotKey(s.slot_key);
    assert(parsed !== null, 'slot_key 无法解析：' + s.slot_key);
    assertEqual(parsed.start_min, s.start_min, s.slot_key + ' start_min 不一致');
    assertEqual(parsed.end_min, s.end_min, s.slot_key + ' end_min 不一致');
    assertEqual(parsed.start_time, s.start_time, s.slot_key + ' start_time 不一致');
    assertEqual(parsed.end_time, s.end_time, s.slot_key + ' end_time 不一致');
  });
});

test('场次分钟数与 PRD 时间对齐（18:20=1100、19:30=1170 等）', () => {
  assertEqual(timeUtil.parseSlotKey('1300_1410').start_min, 780);
  assertEqual(timeUtil.parseSlotKey('1300_1410').end_min, 850);
  assertEqual(timeUtil.parseSlotKey('1940_2050').start_min, 1180);
  assertEqual(timeUtil.parseSlotKey('1940_2050').end_min, 1250);
});
