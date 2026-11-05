/**
 * 多场地并发压测：N 人同时抢 M 个场地（同一时间同一场次）
 * 验证：M 个场地各恰好 1 人成功，其余人被 4100 正确拒绝，无超约、无 500。
 *
 * 说明：与 stress_200_concurrent.js 同源，基于 test/_mock_cloud.js 内存 mock，
 *       只验证「代码逻辑」在并发下的正确性，验证不了微信云端真实并发承载。
 */
const path = require('path');

const mock = require('./_mock_cloud.js');
mock.install();

const ROOT = path.resolve(__dirname, '..');
const CF = path.join(ROOT, 'cloudfunctions', 'cloud');

const config = require(path.join(CF, 'config/config.js'));
const timeUtil = require(path.join(CF, 'framework/utils/time_util.js'));
const appCode = require(path.join(CF, 'framework/core/app_code.js'));
const ReservationService = require(path.join(CF, 'project/service/reservation_service.js'));
const CaptchaService = require(path.join(CF, 'project/service/captcha_service.js'));
const initData = require(path.join(CF, 'project/init/init_data.js'));

/** 解析验证码题目得到正确答案 */
function solveCaptcha(q) {
  const m = /^(\d+)\s*([+\-×])\s*(\d+)\s*=\s*\?$/.exec(String(q).trim());
  if (!m) return '';
  const a = Number(m[1]);
  const b = Number(m[3]);
  if (m[2] === '+') return String(a + b);
  if (m[2] === '-') return String(a - b);
  if (m[2] === '×') return String(a * b);
  return '';
}

const N = Number(process.argv[2]) || 1000; // 并发人数
const VENUES = Number(process.argv[3]) || 6; // 场地数（羽毛球场）

function setup() {
  mock.reset();
  mock.setOpenId('');
  for (const s of initData.TIME_SLOTS) {
    mock.seed(config.COLLECTION.time_slots, Object.assign({ _id: s.slot_key }, s));
  }
  for (let i = 1; i <= VENUES; i++) {
    const key = 'badminton#' + i;
    mock.seed(config.COLLECTION.venues, {
      _id: key, venue_key: key, venue_type: 'badminton', venue_type_name: '羽毛球场',
      court_no: i, closed: false, closed_until: 0, update_time: 0,
    });
  }
  mock.seed(config.COLLECTION.configs, { _id: 'open_time', key: 'open_time', value: config.DEFAULT_OPEN_TIME });
  for (let i = 1; i <= N; i++) {
    const id = 'stu_' + i;
    mock.seed(config.COLLECTION.users, {
      _id: id, openid: id, role: 1, name: '学生' + i, student_no: '2026' + String(i).padStart(4, '0'),
      phone: '138' + String(i).padStart(8, '0'), college: '机械', info_completed: true,
      status: 1, black_until: 0, create_time: 0, update_time: 0,
    });
  }
  mock.setUniqueIndexes([{
    coll: config.COLLECTION.reservations,
    name: 'uniq_student_slot',
    fields: ['student_openid', 'date', 'slot_key'],
  }]);
}

async function main() {
  setup();
  const tomorrow = timeUtil.addDays(timeUtil.today(), 1);
  const fakeNow = timeUtil.dateMinuteToTimestamp(timeUtil.today(), 21 * 60 + 30);
  Date.now = () => fakeNow;
  const weekend = timeUtil.isWeekend(tomorrow);
  const slotObj = initData.TIME_SLOTS.find(
    (s) => s.day_type === 'all' || s.day_type === (weekend ? 'weekend' : 'weekday')
  );

  const svc = new ReservationService();
  const results = { ok: 0, venueTaken: 0, duplicate: 0, other: 0, errors: [] };
  const okVenues = {};

  const oneCall = async (i) => {
    const openid = 'stu_' + (i + 1);
    const user = mock.dump(config.COLLECTION.users).find((u) => u.openid === openid);
    const venueKey = 'badminton#' + ((i % VENUES) + 1);
    try {
      const cap = await new CaptchaService().issue(openid);
      const r = await svc.create(openid, user, {
        date: tomorrow, slot_key: slotObj.slot_key, venue_key: venueKey,
        captcha_token: cap.token, captcha_answer: solveCaptcha(cap.question),
      });
      results.ok++;
      okVenues[venueKey] = (okVenues[venueKey] || 0) + 1;
    } catch (e) {
      const code = e && e.code;
      if (code === appCode.VENUE_TAKEN) results.venueTaken++;
      else if (code === appCode.DUPLICATE_SLOT) results.duplicate++;
      else { results.other++; results.errors.push({ openid: openid, code: code, msg: e && e.message }); }
    }
  };

  await Promise.all(Array.from({ length: N }, (_, i) => oneCall(i)));

  console.log('==============================');
  console.log('多场地并发压测结果（本地内存 mock）');
  console.log('==============================');
  console.log('并发人数 N          = ' + N);
  console.log('场地数 M            = ' + VENUES + '（每个场地约 ' + Math.ceil(N / VENUES) + ' 人竞争）');
  console.log('预约成功            = ' + results.ok + '（期望 ' + VENUES + '）');
  console.log('被拒(4100场地已满)   = ' + results.venueTaken + '（期望 ' + (N - VENUES) + '）');
  console.log('被拒(4101重复)      = ' + results.duplicate + '（期望 0）');
  console.log('其它异常            = ' + results.other + '（期望 0）');
  console.log('成功场地分布        = ' + JSON.stringify(okVenues));
  if (results.errors.length) {
    console.log('异常明细（前 10 条）：');
    results.errors.slice(0, 10).forEach((e) => console.log('  ', JSON.stringify(e)));
  }

  const noOverbook = Object.keys(okVenues).every((k) => okVenues[k] === 1);
  const pass =
    results.ok === VENUES &&
    results.venueTaken === N - VENUES &&
    results.duplicate === 0 &&
    results.other === 0 &&
    noOverbook;

  console.log('==============================');
  console.log(pass
    ? ('结论：PASS ✓（' + VENUES + ' 个场地各恰好 1 人成功，无超约、无重复、无异常/500）')
    : '结论：FAIL ✗');
  console.log('==============================');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('压测脚本自身出错：', e);
  process.exit(2);
});
