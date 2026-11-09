/**
 * reservation 业务逻辑：预约事务（先到先得不超约）/取消/场地状态
 */
const BaseService = require('./base_service.js');
const ReservationModel = require('../model/reservation_model.js');
const ReservationRecordModel = require('../model/reservation_record_model.js');
const StudentSlotLockModel = require('../model/student_slot_lock_model.js');
const VenueModel = require('../model/venue_model.js');
const TimeSlotModel = require('../model/time_slot_model.js');
const ConfigModel = require('../model/config_model.js');
const closeUtil = require('./venue_close_util.js');
const dbUtil = require('../../framework/database/db_util.js');
const config = require('../../config/config.js');
const timeUtil = require('../../framework/utils/time_util.js');
const appCode = require('../../framework/core/app_code.js');
const AppError = require('../../framework/core/app_error.js');

class ReservationService extends BaseService {
  /** 某日某场次各场地状态 */
  async status({ date, slot_key, venue_type }) {
    const slot = await TimeSlotModel.getOne(slot_key);
    if (!slot) this.AppError('场次不存在', appCode.LOGIC);

    const where = venue_type ? { venue_type: venue_type } : {};
    const venues = await VenueModel.getAll(where, '*', { court_no: 'asc' });
    // M-5：占用统计须含 checked_in（签到后占用文档 status 变 checked_in，只数 pending 会误显示「可预约」）
    const bookings = await ReservationModel.getAll(
      { date: date, slot_key: slot_key, status: ['in', ['pending', 'checked_in']] },
      'venue_key'
    );
    const bookedSet = {};
    bookings.forEach((b) => { bookedSet[b.venue_key] = true; });

    const now = timeUtil.now();
    return venues.map((v) => {
      // 闭馆按「场次开始时间 vs 恢复时刻」逐场次判定，不再「当天有闭馆就锁全天」
      const verdict = closeUtil.evaluateSlot(v, date, slot, now);
      let status = 'available';
      if (verdict.blocked) status = 'closed';
      else if (bookedSet[v.venue_key]) status = 'booked';

      return {
        venue_key: v.venue_key,
        court_no: v.court_no,
        venue_type: v.venue_type,
        venue_type_name: v.venue_type_name,
        status: status,
        // 仅闭馆时返回恢复信息，前端据此显示「至 19:35 恢复」并提示可选场次
        closed_until: verdict.blocked ? verdict.until : 0,
        closed_until_text: verdict.blocked ? closeUtil.untilText(verdict.until, date) : '',
      };
    });
  }

  /** 提交预约（事务 + 唯一键冲突映射；防脚本由 application 层窗口限流兜底，无需人机验证码） */
  async create(openId, user, { date, slot_key, venue_key }) {
    if (!user || !user.info_completed) this.AppError('请先完善个人信息', appCode.NO_PROFILE);
    const now = timeUtil.now();

    // 被拉黑校验（中间件已拦截，此处兜底）
    if (user.black_until && user.black_until > now) {
      const days = Math.ceil((user.black_until - now) / config.DAY_MS);
      this.AppError('您已被限制预约，' + days + ' 天内不可预约场馆', appCode.BLACKLIST, { black_days: days });
    }

    // 开放时间决定可约日期：未到开放时刻只能约「今天」，已过开放时刻只能约「明天」
    const openTime = await this.getOpenTime();
    const openMin = (Number(openTime.hour) || 0) * 60 + (Number(openTime.minute) || 0);
    const nowMin = timeUtil.nowMinutes();
    if (nowMin < openMin) {
      if (date !== timeUtil.today()) {
        this.AppError('未到预约开放时间（' + timeUtil.minToTime(openMin) + ' 后开放次日预约）', appCode.NOT_OPEN_TIME);
      }
    } else {
      if (date !== timeUtil.tomorrow()) {
        this.AppError('预约已关闭，请预约明天的场次', appCode.NOT_OPEN_TIME);
      }
    }

    // 场次校验（匹配日期的工作日/周末）
    const slot = await TimeSlotModel.getOne(slot_key);
    if (!slot) this.AppError('场次不存在', appCode.LOGIC);
    const weekend = timeUtil.isWeekend(date);
    if (slot.day_type !== 'all' && slot.day_type !== (weekend ? 'weekend' : 'weekday')) {
      this.AppError('该场次当日不开放', appCode.LOGIC);
    }
    // 场次已开始/已结束不可约：前端的时间判断不可信，以服务端时间兜底
    const slotStartTs = timeUtil.dateMinuteToTimestamp(date, slot.start_min);
    if (slotStartTs <= now) {
      this.AppError('该场次已开始或已结束，不可预约', appCode.NOT_OPEN_TIME);
    }

    // 场地校验（闭馆不可约）：按本场次开始时间与闭馆恢复时刻比对，
    // 恢复之后才开始的场次可正常预约（旧逻辑只看「现在是否闭馆」，会误锁全天）
    const venue = await VenueModel.getOne(venue_key);
    if (!venue) this.AppError('场地不存在', appCode.LOGIC);
    const verdict = closeUtil.evaluateSlot(venue, date, slot, now);
    if (verdict.blocked) {
      const tip = verdict.permanent
        ? '该场地已闭馆，暂不可预约'
        : '该场地闭馆至 ' + closeUtil.untilText(verdict.until, date) + '，本场次不可预约';
      this.AppError(tip, appCode.VENUE_CLOSED, { closed_until: verdict.until });
    }

    // 应用层快速查重（事务外先拦一次，减少事务开销）；并发兜底由下方事务内 student_slot_locks._id 主键保证。
    // 拉取该学生该日期该场次的全量预约后自行判断，避免依赖 neq 数据库条件在不同版本上的兼容差异。
    const existing = await ReservationModel.getAll(
      { student_openid: openId, date: date, slot_key: slot_key, status: 'pending' },
      'venue_key'
    );
    if (existing.some((r) => r.venue_key && r.venue_key !== venue_key)) {
      this.AppError('您在该时段已预约其他场地', appCode.DUPLICATE_SLOT);
    }

    const resId = date + '_' + slot_key + '_' + venue_key;
    const resData = {
      _id: resId,
      student_openid: openId,
      student_name: user.name || '',
      student_no: user.student_no || '',
      date: date,
      slot_key: slot_key,
      venue_key: venue_key,
      venue_type: venue.venue_type,
      court_no: venue.court_no,
      status: 'pending',
      checkin_time: 0,
      create_time: now,
    };
    const recordData = {
      res_id: resId,
      student_openid: openId,
      student_name: user.name || '',
      date: date,
      slot_key: slot_key,
      venue_key: venue_key,
      venue_type: venue.venue_type,
      venue_type_name: venue.venue_type_name,
      court_no: venue.court_no,
      status: 'pending',
      cancel_time: 0,
      cancel_reason: '',
      notified: 0,
      create_time: now,
      update_time: now,
    };

    // 学生时段锁：_id = openid_date_slot，主键天然唯一，兜底「同一学生同一时段只约 1 个场地」
    const lockId = StudentSlotLockModel.key(openId, date, slot_key);
    const lockData = {
      _id: lockId,
      student_openid: openId,
      date: date,
      slot_key: slot_key,
      venue_key: venue_key,
      res_id: resId,
      create_time: now,
    };

    try {
      await dbUtil.runTransaction(async (t) => {
        // 1) 事务内 doc 级预检：场地是否已占用（命中 -> 4100）
        let occupied = null;
        try {
          const oc = await t.collection(config.COLLECTION.reservations).doc(resId).get();
          occupied = oc && oc.data ? oc.data : null;
        } catch (e) {
          // doc 不存在视为未占用；其他异常照常抛出
          const m = String((e && (e.errMsg || e.message)) || '');
          if (
            m.indexOf('not exist') >= 0 ||
            m.indexOf('not found') >= 0 ||
            m.indexOf('does not exist') >= 0 ||
            m.indexOf('cannot find') >= 0
          ) {
            occupied = null;
          } else {
            throw e;
          }
        }
        if (occupied) {
          throw new AppError('该场地已被预约', appCode.VENUE_TAKEN);
        }

        // 2) 学生时段锁：占锁（_id 冲突 = 该学生该时段已约其他场地 -> 4101），并发下仍可靠
        try {
          await t.collection(config.COLLECTION.student_slot_locks).add({ data: lockData });
        } catch (e) {
          const m = String((e && (e.errMsg || e.message)) || '');
          if (m.indexOf('duplicate') >= 0 || m.indexOf('dup') >= 0 || m.indexOf('already exist') >= 0) {
            throw new AppError('您在该时段已预约其他场地', appCode.DUPLICATE_SLOT);
          }
          throw e;
        }

        // 3) 事务内 add：场地不超约由 reservations._id 主键兜底；防重复由上方 student_slot_locks._id 主键兜底
        await t.collection(config.COLLECTION.reservations).add({ data: resData });
        await t.collection(config.COLLECTION.reservation_records).add({ data: recordData });
      });
    } catch (err) {
      // 事务内 doc.get 预检抛出的业务错误优先
      if (err && err.name === 'AppError') throw err;
      if (err && err.code === appCode.VENUE_TAKEN) this.AppError('该场地已被预约', appCode.VENUE_TAKEN);
      if (err && err.code === appCode.DUPLICATE_SLOT) this.AppError('您在该时段已预约其他场地', appCode.DUPLICATE_SLOT);

      // add 唯一键冲突：事务外精确区分 4100/4101（add 已失败，未重复写入）
      const takenCnt = await ReservationModel.count({ _id: resId });
      if (takenCnt > 0) {
        this.AppError('该场地已被预约', appCode.VENUE_TAKEN);
      }
      const dupCnt = await ReservationModel.count({ student_openid: openId, date: date, slot_key: slot_key, status: 'pending' });
      if (dupCnt > 0) {
        this.AppError('您在该时段已预约其他场地', appCode.DUPLICATE_SLOT);
      }

      // 极端竞态（场地刚被释放）或未知冲突
      const msg = String((err && (err.errMsg || err.message)) || '');
      if (msg.indexOf('dup') >= 0 || msg.indexOf('duplicate') >= 0 || msg.indexOf('already exist') >= 0) {
        this.AppError('该场地已被预约', appCode.VENUE_TAKEN);
      }
      throw err;
    }

    return { res_id: resId, date: date, slot_key: slot_key, venue_key: venue_key };
  }

  /** 取消预约（开始前 30 分钟，物理删除占用 + 流水改 cancelled） */
  async cancel(openId, { res_id }) {
    const res = await ReservationModel.getOne(res_id);
    if (!res || res.student_openid !== openId) this.AppError('预约不存在', appCode.LOGIC);
    // M-6：显式状态守卫，仅待签到可取消（防御签到后取消等状态机打穿）
    if (res.status !== 'pending') this.AppError('当前状态不可取消', appCode.LOGIC);

    const si = timeUtil.parseSlotKey(res.slot_key);
    const startTs = timeUtil.dateMinuteToTimestamp(res.date, si.start_min);
    const now = timeUtil.now();
    if (now >= startTs - config.CANCEL_BEFORE_MIN * 60 * 1000) {
      this.AppError('场次开始前 ' + config.CANCEL_BEFORE_MIN + ' 分钟内不可取消', appCode.CANCEL_TOO_LATE);
    }

    // M-6：流水更新移入事务内，保证「删占用 + 删锁 + 流水置 cancelled」原子一致
    const rec = await ReservationRecordModel.getOne({ res_id: res_id, status: 'pending' });
    await dbUtil.runTransaction(async (t) => {
      // 事务内同时删除占用表 + 学生时段锁，立即释放场地（关键：保证他人可再约、本人可再约同时段其他场地）
      await t.collection(config.COLLECTION.reservations).doc(res_id).remove();
      await t.collection(config.COLLECTION.student_slot_locks)
        .doc(StudentSlotLockModel.key(openId, res.date, res.slot_key)).remove();
      if (rec) {
        await t.collection(config.COLLECTION.reservation_records).doc(rec._id).update({
          data: { status: 'cancelled', cancel_time: now, update_time: now },
        });
      }
    });

    return { cancelled: true };
  }

  async getOpenTime() {
    const cfg = await ConfigModel.getOne('open_time');
    return cfg && cfg.value ? cfg.value : config.DEFAULT_OPEN_TIME;
  }
}

module.exports = ReservationService;
