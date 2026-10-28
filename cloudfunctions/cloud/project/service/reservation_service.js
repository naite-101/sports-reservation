/**
 * reservation 业务逻辑：预约事务（先到先得不超约）/取消/场地状态
 */
const BaseService = require('./base_service.js');
const ReservationModel = require('../model/reservation_model.js');
const ReservationRecordModel = require('../model/reservation_record_model.js');
const VenueModel = require('../model/venue_model.js');
const TimeSlotModel = require('../model/time_slot_model.js');
const ConfigModel = require('../model/config_model.js');
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
    const bookings = await ReservationModel.getAll({ date: date, slot_key: slot_key }, 'venue_key');
    const bookedSet = {};
    bookings.forEach((b) => { bookedSet[b.venue_key] = true; });

    const now = timeUtil.now();
    return venues.map((v) => {
      const closed = !!(v.closed && (!v.closed_until || v.closed_until > now));
      let status = 'available';
      if (closed) status = 'closed';
      else if (bookedSet[v.venue_key]) status = 'booked';
      return {
        venue_key: v.venue_key,
        court_no: v.court_no,
        venue_type: v.venue_type,
        venue_type_name: v.venue_type_name,
        status: status,
      };
    });
  }

  /** 提交预约（事务 + 唯一键冲突映射） */
  async create(openId, user, { date, slot_key, venue_key }) {
    if (!user || !user.info_completed) this.AppError('请先完善个人信息', appCode.NO_PROFILE);
    const now = timeUtil.now();

    // 被拉黑校验（中间件已拦截，此处兜底）
    if (user.black_until && user.black_until > now) {
      const days = Math.ceil((user.black_until - now) / 86400000);
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
    if (timeUtil.dateMinuteToTimestamp(date, slot.start_min) <= now) {
      this.AppError('该场次已开始或已结束，不可预约', appCode.NOT_OPEN_TIME);
    }

    // 场地校验（闭馆不可约）
    const venue = await VenueModel.getOne(venue_key);
    if (!venue) this.AppError('场地不存在', appCode.LOGIC);
    if (venue.closed && (!venue.closed_until || venue.closed_until > now)) {
      this.AppError('该场地临时闭馆，不可预约', appCode.VENUE_CLOSED);
    }

    // 唯一索引无法由 SDK 自动创建（见 README 第 5 步），缺索引时这里补一次跨场地查重
    const dupCntPre = await ReservationModel.count({
      student_openid: openId, date: date, slot_key: slot_key,
      venue_key: ['!=', venue_key],
    });
    if (dupCntPre > 0) {
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

    try {
      await dbUtil.runTransaction(async (t) => {
        // 事务内 doc 级预检：场地是否已占用（命中 -> 4100）
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

        // 事务内只做 doc 级操作 + add；「不超约/防重复」由 _id 主键 + uniq_student_slot 唯一索引兜底
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
      const dupCnt = await ReservationModel.count({ student_openid: openId, date: date, slot_key: slot_key });
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

    const si = timeUtil.parseSlotKey(res.slot_key);
    const startTs = timeUtil.dateMinuteToTimestamp(res.date, si.start_min);
    const now = timeUtil.now();
    if (now >= startTs - 30 * 60 * 1000) {
      this.AppError('场次开始前 30 分钟内不可取消', appCode.CANCEL_TOO_LATE);
    }

    await dbUtil.runTransaction(async (t) => {
      // 事务内仅做占用表 doc 级删除，立即释放场地（关键：保证他人可再约）
      await t.collection(config.COLLECTION.reservations).doc(res_id).remove();
    });

    // 流水表更新移到事务外（事务外 where 合法；失败可由 job/expire 兜底）
    await ReservationRecordModel.edit(
      { res_id: res_id, status: 'pending' },
      { status: 'cancelled', cancel_time: now, update_time: now }
    );

    return { cancelled: true };
  }

  async getOpenTime() {
    const cfg = await ConfigModel.getOne('open_time');
    return cfg && cfg.value ? cfg.value : config.DEFAULT_OPEN_TIME;
  }
}

module.exports = ReservationService;
