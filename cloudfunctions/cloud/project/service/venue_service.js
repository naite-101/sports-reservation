/**
 * venue 业务逻辑：场馆/场次/闭馆
 */
const BaseService = require('./base_service.js');
const VenueModel = require('../model/venue_model.js');
const ReservationModel = require('../model/reservation_model.js');
const ReservationRecordModel = require('../model/reservation_record_model.js');
const TimeSlotModel = require('../model/time_slot_model.js');
const ConfigModel = require('../model/config_model.js');
const OperationLogModel = require('../model/operation_log_model.js');
const dbUtil = require('../../framework/database/db_util.js');
const config = require('../../config/config.js');
const timeUtil = require('../../framework/utils/time_util.js');
const appCode = require('../../framework/core/app_code.js');

class VenueService extends BaseService {
  /** 三馆场地列表 + 闭馆状态 */
  async list() {
    const venues = await VenueModel.getAll({}, '*', { venue_type: 'asc', court_no: 'asc' });
    const now = timeUtil.now();
    const result = [];
    for (const type in config.VENUE_TYPES) {
      const info = config.VENUE_TYPES[type];
      const courts = venues
        .filter((v) => v.venue_type === type)
        .map((v) => ({
          venue_key: v.venue_key,
          venue_type: v.venue_type,
          venue_type_name: v.venue_type_name,
          court_no: v.court_no,
          closed: !!(v.closed && (!v.closed_until || v.closed_until > now)),
        }));
      result.push({ venue_type: type, venue_type_name: info.name, count: info.count, courts: courts });
    }
    return result;
  }

  /** 可约日场次列表 + 开放时间（21:00 前约当天，21:00 后约次日） */
  async slotList() {
    const open_time = await this.getOpenTime();
    const openMin = (Number(open_time.hour) || 0) * 60 + (Number(open_time.minute) || 0);
    const nowMin = timeUtil.nowMinutes();
    const is_today = nowMin < openMin;
    const date = is_today ? timeUtil.today() : timeUtil.tomorrow();
    const weekend = timeUtil.isWeekend(date);
    const slots = await TimeSlotModel.getAll({}, '*', { sort: 'asc' });
    const daySlots = slots
      .filter((s) => s.day_type === 'all' || s.day_type === (weekend ? 'weekend' : 'weekday'))
      .filter((s) => !is_today || s.start_min > nowMin)
      .map((s) => ({
        slot_key: s.slot_key,
        start_time: s.start_time,
        end_time: s.end_time,
        start_min: s.start_min,
        end_min: s.end_min,
      }));
    return {
      date: date,
      date_type: is_today ? 'today' : 'tomorrow',
      is_today: is_today,
      day_type: weekend ? 'weekend' : 'weekday',
      slots: daySlots,
      open_time: open_time,
    };
  }

  /** 开放时间配置 */
  async getOpenTime() {
    const cfg = await ConfigModel.getOne('open_time');
    return cfg && cfg.value ? cfg.value : config.DEFAULT_OPEN_TIME;
  }

  /** 设置临时闭馆 / 恢复开放 */
  async close(operator, { venue_key, closed, closed_until }) {
    const venue = await VenueModel.getOne(venue_key);
    if (!venue) this.AppError('场地不存在', appCode.LOGIC);
    const now = timeUtil.now();
    const data = {
      closed: !!closed,
      closed_until: closed_until ? Number(closed_until) : 0,
      update_time: now,
    };
    await VenueModel.edit(venue_key, data);

    let cancelled = 0;
    // 闭馆时联动取消该场地已有的 pending 预约并立即释放占用，避免学生仍可按闭馆场地签到
    if (closed) {
      cancelled = await this.cancelVenueBookings(venue_key, now);
    }

    await OperationLogModel.insert({
      module: 'venue_close',
      action: closed ? 'close_venue' : 'open_venue',
      operator_openid: operator._id,
      operator_name: operator.name || '',
      operator_role: operator.role,
      target_desc: venue_key,
      detail: Object.assign({}, data, { cancelled_bookings: cancelled }),
      create_time: now,
    });
    return { venue_key: venue_key, closed: !!closed, cancelled_bookings: cancelled };
  }

  /** 闭馆联动：取消某场地所有 pending 预约，释放实时占用表 */
  async cancelVenueBookings(venue_key, now) {
    const pendings = await ReservationModel.getAll(
      { venue_key: venue_key, status: 'pending' },
      '_id,student_openid,date,slot_key',
      { create_time: 'asc' }
    );
    let cancelled = 0;
    for (const b of pendings) {
      try {
        await dbUtil.getDb().collection(config.COLLECTION.reservations).doc(b._id).remove();
      } catch (e) {
        console.error('[venue_close] 释放占用失败 res_id=' + b._id, e);
      }
      const upd = await ReservationRecordModel.edit(
        { res_id: b._id, status: 'pending' },
        { status: 'cancelled', cancel_time: now, cancel_reason: 'venue_closed', update_time: now }
      );
      if (upd === 1) cancelled++;
    }
    return cancelled;
  }

  /** 闭馆列表 */
  async closeList() {
    const list = await VenueModel.getAll({ closed: true }, '*', { venue_type: 'asc', court_no: 'asc' });
    const now = timeUtil.now();
    return list.filter((v) => !v.closed_until || v.closed_until > now);
  }
}

module.exports = VenueService;
