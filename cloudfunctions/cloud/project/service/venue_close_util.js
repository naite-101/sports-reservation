/**
 * 场地闭馆判定工具（后端唯一判定入口）
 *
 * 本次修复的 Bug：
 *   旧逻辑拿「闭馆恢复时间 vs 当前时间」判断（closed_until > now 就算闭馆），
 *   恢复时间还没到，就把该场地当天所有场次一起置灰，与场次起止时间无关。
 *   正确逻辑：拿「场次开始时间 vs 闭馆恢复时间」判断，恢复之后才开始的场次应正常可约。
 *
 * 数据语义（venues 表，一条场地一条闭馆记录）：
 *   closed=false                   → 无闭馆记录
 *   closed=true,  closed_until<=0  → 永久闭馆（需管理员手动恢复）
 *   closed=true,  closed_until>0   → 临时闭馆，closed_until 为「恢复开放时刻」
 *
 * 判定规则（逐条遍历闭馆记录，对比场次起止时间与恢复时刻）：
 *   1) 恢复时刻已过（now >= until）    → 该条记录失效，自动解除闭馆
 *   2) 场次开始时间 >= 恢复时刻        → 场次在恢复之后才开始，可预约
 *   3) 场次开始时间 <  恢复时刻        → 场次落在闭馆时段内，保持锁定
 *   永久闭馆没有恢复时刻 → 任何日期、任何场次都锁定。
 *
 * 示例（恢复时间 19:35，当天 19:40-20:50 场次）：
 *   18:20-19:30 → 开始 18:20 < 19:35 → 闭馆锁定
 *   19:40-20:50 → 开始 19:40 ≥ 19:35 → 可预约 ✓
 */
const timeUtil = require('../../framework/utils/time_util.js');

/** 恢复时刻统一转正整数时间戳；0 / 负数 / 非法值都视为「无恢复时刻（永久）」 */
function toTimestamp(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 把场地的闭馆信息规范成「闭馆记录」数组。
 * 目前 venues 表一条场地最多一条记录；若后续扩展为多条闭馆窗口，
 * 只需在这里追加记录，下面的判定/联动取消逻辑无需改动。
 */
function closureRecords(venue) {
  if (!venue || !venue.closed) return [];
  const until = toTimestamp(venue.closed_until);
  return [{ until: until, permanent: until <= 0 }];
}

/**
 * 判定某场次是否被闭馆拦截
 * @param {object} venue 场地（closed / closed_until）
 * @param {string} date  场次日期 YYYY-MM-DD
 * @param {object} slot  场次（{ start_min, end_min }，来自 TimeSlotModel 或 parseSlotKey）
 * @param {number} now   当前毫秒时间戳
 * @returns {{blocked:boolean, permanent:boolean, until:number, slot_start:number, slot_end:number}}
 */
function evaluateSlot(venue, date, slot, now) {
  const nowTs = Number(now) || timeUtil.now();
  const startMin = Number(slot && slot.start_min) || 0;
  const endMin = Number(slot && slot.end_min) || 0;
  const slotStart = timeUtil.dateMinuteToTimestamp(date, startMin);
  const slotEnd = timeUtil.dateMinuteToTimestamp(date, endMin);

  const records = closureRecords(venue);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];

    // 永久闭馆：没有恢复时刻，任何场次都进不去
    if (rec.permanent) {
      return { blocked: true, permanent: true, until: 0, slot_start: slotStart, slot_end: slotEnd };
    }

    // 恢复时刻已过：这条闭馆记录自动失效，继续看下一条
    if (nowTs >= rec.until) continue;

    // 核心：场次在恢复时刻之后才开始，不受这条闭馆记录影响
    if (slotStart >= rec.until) continue;

    // 场次开始时间早于恢复时刻：落在闭馆时段内，保持锁定
    return { blocked: true, permanent: false, until: rec.until, slot_start: slotStart, slot_end: slotEnd };
  }

  return { blocked: false, permanent: false, until: 0, slot_start: slotStart, slot_end: slotEnd };
}

/** 是否「此刻」处于闭馆状态（仅管理端状态展示用，不参与场次判定） */
function isClosedNow(venue, now) {
  const nowTs = Number(now) || timeUtil.now();
  const records = closureRecords(venue);
  for (let i = 0; i < records.length; i++) {
    if (records[i].permanent || nowTs < records[i].until) return true;
  }
  return false;
}

/** 恢复时刻文案：同一天显示 19:35，跨天显示 11-10 19:35；永久闭馆返回空串 */
function untilText(until, date) {
  const ts = toTimestamp(until);
  if (!ts) return '';
  return timeUtil.formatDate(ts) === String(date)
    ? timeUtil.timestamp2Time(ts, 'h:m')
    : timeUtil.timestamp2Time(ts, 'M-D h:m');
}

module.exports = {
  closureRecords: closureRecords,
  evaluateSlot: evaluateSlot,
  isClosedNow: isClosedNow,
  untilText: untilText,
};
