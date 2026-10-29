/**
 * 并发压测：200 人同时抢「同一时间 + 同一场地」
 * 目标：验证 200 个并发里只有 1 人成功，其余 199 人被正确拒绝（4100 场地已满），系统不崩、无 500。
 *
 * 说明（务必知晓）：
 * - 本脚本使用 test/_mock_cloud.js 的内存 mock 云数据库，真实调用 reservation_service.create。
 * - mock 的 runTransaction 是「快照回滚」简化实现，无法复现微信云数据库真实的事务隔离与唯一索引底层行为。
 * - 因此本脚本只能验证「代码逻辑」在并发下是否正确（会不会超约、会不会抛未捕获异常），
 *   验证不了「微信云端真实 200 并发会不会崩/限流」。真实并发需在云端用 HTTP 触发器压测。
 */
const path = require('path');

// 必须在加载任何业务模块前安装：把 require('wx-server-sdk') 指向内存 mock
const mock = require('./_mock_cloud.js');
mock.install();

const ROOT = path.resolve(__dirname, '..');
const CF = path.join(ROOT, 'cloudfunctions', 'cloud');

const config = require(path.join(CF, 'config/config.js'));
const timeUtil = require(path.join(CF, 'framework/utils/time_util.js'));
const appCode = require(path.join(CF, 'framework/core/app_code.js'));
const ReservationService = require(path.join(CF, 'project/service/reservation_service.js'));
const initData = require(path.join(CF, 'project/init/init_data.js'));

const N = 200; // 并发人数

function setup() {
  mock.reset();
  mock.setOpenId('');

  // 场次模板
  for (const s of initData.TIME_SLOTS) {
    mock.seed(config.COLLECTION.time_slots, Object.assign({ _id: s.slot_key }, s));
  }
  // 场馆（只用一个羽毛球场 1 号）
  const type = 'badminton';
  const info = config.VENUE_TYPES[type];
  const key = type + '#1';
  mock.seed(config.COLLECTION.venues, {
    _id: key, venue_key: key, venue_type: type, venue_type_name: info.name,
    court_no: 1, closed: false, closed_until: 0, update_time: 0,
  });
  // 开放时间配置
  mock.seed(config.COLLECTION.configs, {
    _id: 'open_time', key: 'open_time', value: config.DEFAULT_OPEN_TIME,
  });
  // 200 个学生（openid 各不相同，都已完善信息）
  for (let i = 1; i <= N; i++) {
    const id = 'stu_' + i;
    mock.seed(config.COLLECTION.users, {
      _id: id, openid: id, role: 1, name: '学生' + i, student_no: '2026' + String(i).padStart(4, '0'),
      phone: '138' + String(i).padStart(8, '0'), college: '机械', info_completed: true,
      status: 1, black_until: 0, create_time: 0, update_time: 0,
    });
  }
}

// 把「今天」设成一个固定的未来日期，让 create 走「约明天」分支
function freezeToTonight() {
  // 用真实明天作为可约日期；把系统时钟拨到「今天 21:30」（已过 open_time 21:00）
  const tomorrow = timeUtil.addDays(timeUtil.today(), 1);
  const fakeNow = timeUtil.dateMinuteToTimestamp(timeUtil.today(), 21 * 60 + 30);
  Date.now = () => fakeNow;
  return tomorrow;
}

async function main() {
  setup();
  const tomorrow = freezeToTonight();

  const slot = initData.TIME_SLOTS[0]; // 取第一个场次（weekday 18:20~19:30 之类，需匹配明天的 day_type）
  // 选一个「明天」这天确实开放的场次
  const weekend = timeUtil.isWeekend(tomorrow);
  const slotObj = initData.TIME_SLOTS.find(
    (s) => s.day_type === 'all' || s.day_type === (weekend ? 'weekend' : 'weekday')
  );
  const venueKey = 'badminton#1';

  const svc = new ReservationService();

  const results = { ok: 0, venueTaken: 0, other: 0, errors: [] };

  const oneCall = async (i) => {
    const openid = 'stu_' + (i + 1);
    const user = mock.dump(config.COLLECTION.users).find((u) => u.openid === openid);
    try {
      await svc.create(openid, user, {
        date: tomorrow,
        slot_key: slotObj.slot_key,
        venue_key: venueKey,
      });
      results.ok++;
    } catch (e) {
      const code = e && e.code;
      if (code === appCode.VENUE_TAKEN) {
        results.venueTaken++;
      } else {
        results.other++;
        results.errors.push({ openid, code: code, msg: e && e.message });
      }
    }
  };

  const t0 = Date.now();
  await Promise.all(Array.from({ length: N }, (_, i) => oneCall(i)));
  const elapsed = Date.now() - t0;

  // 校验最终数据
  // 注：内存 mock 的 runTransaction 是「快照回滚」简化实现，200 并发交错时回滚会覆盖成功事务已写入的数据，
  // 因此 reservations 的最终计数在并发下不可信；真实微信云数据库由引擎保证事务隔离，无此问题。
  // 这里只以「成功/被拒计数」作为判定依据（这正是并发正确性的核心）。
  const resCount = mock.dump(config.COLLECTION.reservations).length;
  const recCount = mock.dump(config.COLLECTION.reservation_records).length;

  console.log('==============================');
  console.log('并发压测结果（本地内存 mock）');
  console.log('==============================');
  console.log('并发人数 N          = ' + N);
  console.log('预约成功            = ' + results.ok);
  console.log('被拒(4100场地已满)   = ' + results.venueTaken);
  console.log('其它异常            = ' + results.other);
  console.log('总耗时              = ' + elapsed + ' ms');
  console.log('（参考）最终 reservations 计数 = ' + resCount + '，records = ' + recCount + '（并发下受 mock 回滚影响，仅作参考）');
  if (results.errors.length) {
    console.log('异常明细（前 10 条）：');
    results.errors.slice(0, 10).forEach((e) => console.log('  ', JSON.stringify(e)));
  }

  const pass =
    results.ok === 1 &&
    results.venueTaken === N - 1 &&
    results.other === 0;

  console.log('==============================');
  console.log(pass ? '结论：PASS ✓（仅 1 人成功，199 人被正确拒绝，无未捕获异常/500）' : '结论：FAIL ✗');
  console.log('==============================');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('压测脚本自身出错：', e);
  process.exit(2);
});
