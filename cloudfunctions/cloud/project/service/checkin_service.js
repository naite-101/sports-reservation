/**
 * checkin 业务逻辑：扫码校验 / 签到（含附属人员，幂等）
 */
const BaseService = require('./base_service.js');
const QrcodeTokenModel = require('../model/qrcode_token_model.js');
const ReservationModel = require('../model/reservation_model.js');
const ReservationRecordModel = require('../model/reservation_record_model.js');
const VenueModel = require('../model/venue_model.js');
const CheckinRecordModel = require('../model/checkin_record_model.js');
const UserModel = require('../model/user_model.js');
const OperationLogModel = require('../model/operation_log_model.js');
const closeUtil = require('./venue_close_util.js');
const dbUtil = require('../../framework/database/db_util.js');
const config = require('../../config/config.js');
const timeUtil = require('../../framework/utils/time_util.js');
const appCode = require('../../framework/core/app_code.js');

class CheckinService extends BaseService {
  /** 扫码校验 token -> 返回学生 + 有效预约 */
  async scan(token, slotKey) {
    const tokenDoc = await QrcodeTokenModel.getOne({ token: token });
    if (!tokenDoc || !tokenDoc.expire_time || tokenDoc.expire_time <= timeUtil.now()) {
      this.AppError('二维码已过期，请刷新后重试', appCode.QR_EXPIRED);
    }
    const studentOpenid = tokenDoc.student_openid;
    const booking = await this.findValidBooking(studentOpenid);
    if (!booking) this.AppError('该学生当前无有效预约', appCode.NO_VALID_BOOKING);
    if (slotKey && booking.slot_key !== slotKey) this.AppError('预约场次不匹配', appCode.SLOT_MISMATCH);

    const student = await UserModel.getOne(studentOpenid);
    return {
      student: {
        name: student ? student.name : booking.student_name,
        student_no: student ? student.student_no : '',
        openid: studentOpenid,
      },
      booking: booking,
    };
  }

  /** 确认签到（窗口 = 开始前15min ~ 结束；幂等 _id=res_id） */
  async checkin(operator, { res_id, slot_key, companions }) {
    const res = await ReservationModel.getOne(res_id);
    if (!res) this.AppError('预约不存在', appCode.NO_VALID_BOOKING);
    const now = timeUtil.now();

    // 场次匹配校验（前端扫码后回传 slot_key，防止预约变更后误签）
    if (slot_key && res.slot_key !== slot_key) {
      this.AppError('预约场次不匹配', appCode.SLOT_MISMATCH);
    }

    // 闭馆场地不可签到：按「本次预约的场次开始时间 vs 恢复时刻」判定，
    // 恢复之后才开始的场次可正常签到（避免临时闭馆误伤后续场次的学生）
    const si = timeUtil.parseSlotKey(res.slot_key);
    const venue = await VenueModel.getOne(res.venue_key);
    if (venue && si) {
      const verdict = closeUtil.evaluateSlot(venue, res.date, si, now);
      if (verdict.blocked) {
        this.AppError('该场地已闭馆，无法签到', appCode.VENUE_CLOSED);
      }
    }

    // 幂等：已签到直接返回
    if (res.status === 'checked_in') {
      const rec = await CheckinRecordModel.getOne(res_id);
      return { checkin_time: rec ? rec.checkin_time : res.checkin_time, already: true };
    }

    // 黑名单拦截：被拉黑的学生不可再签到（幂等分支之后判断，避免重复调用报错）
    const studentUser = await UserModel.getOne(res.student_openid);
    const studentBlackUntil = studentUser && studentUser.black_until ? studentUser.black_until : 0;
    if (studentBlackUntil > now) {
      const blackDays = Math.ceil((studentBlackUntil - now) / config.DAY_MS);
      this.AppError('该用户已被拉黑（剩余 ' + blackDays + ' 天），无法签到', appCode.BLACKLIST, { black_days: blackDays });
    }

    const winStart = timeUtil.dateMinuteToTimestamp(res.date, si.start_min) - config.CHECKIN_BEFORE_MIN * 60 * 1000;
    const endTs = timeUtil.dateMinuteToTimestamp(res.date, si.end_min);
    if (now < winStart || now > endTs) {
      this.AppError('不在签到时间窗口（场次开始前 15 分钟至结束）', appCode.LOGIC);
    }

    companions = Array.isArray(companions) ? companions : [];
    const venueTypeName = config.VENUE_TYPES[res.venue_type] ? config.VENUE_TYPES[res.venue_type].name : '';

    const checkinData = {
      _id: res_id,
      res_id: res_id,
      student_openid: res.student_openid,
      student_name: res.student_name,
      student_no: res.student_no,
      date: res.date,
      slot_key: res.slot_key,
      venue_key: res.venue_key,
      venue_type: res.venue_type,
      venue_type_name: venueTypeName,
      court_no: res.court_no,
      companions: companions,
      admin_openid: operator._id,
      admin_name: operator.name || '',
      checkin_time: now,
    };

    try {
      await dbUtil.runTransaction(async (t) => {
        // 事务内仅占用表 doc 级更新 + 签到记录 add（幂等 _id=res_id）
        await t.collection(config.COLLECTION.reservations).doc(res_id).update({
          data: { status: 'checked_in', checkin_time: now },
        });
        await t.collection(config.COLLECTION.checkin_records).add({ data: checkinData });
      });
    } catch (err) {
      // 并发重复签到：checkin_records(_id=res_id) 主键冲突 -> 幂等成功语义
      const msg = String((err && (err.errMsg || err.message)) || '');
      const isDup = msg.indexOf('dup') >= 0 || msg.indexOf('duplicate') >= 0 || msg.indexOf('already exist') >= 0;
      if (isDup) {
        const rec = await CheckinRecordModel.getOne(res_id);
        if (rec) {
          return { checkin_time: rec.checkin_time, already: true };
        }
      }
      throw err;
    }

    // 流水表更新移到事务外（事务外 where 合法；失败可由 job/expire 兜底）
    await ReservationRecordModel.edit(
      { res_id: res_id, status: 'pending' },
      { status: 'checked_in', update_time: now }
    );

    await OperationLogModel.insert({
      module: 'checkin',
      action: 'checkin',
      operator_openid: operator._id,
      operator_name: operator.name || '',
      operator_role: operator.role,
      target_openid: res.student_openid,
      target_desc: res.date + ' ' + res.slot_key + ' ' + res.venue_key,
      detail: { res_id: res_id, companions: companions },
      create_time: now,
    });

    return { checkin_time: now };
  }

  /** 当日签到记录（按场馆/场次筛选） */
  async checkinRecords({ venue_type, slot_key }) {
    const today = timeUtil.today();
    const where = { date: today };
    if (venue_type) where.venue_type = venue_type;
    if (slot_key) where.slot_key = slot_key;
    return await CheckinRecordModel.getAll(where, '*', { checkin_time: 'desc' });
  }

  /** 查找有效预约（今天 + pending + 窗口内） */
  async findValidBooking(openId) {
    const today = timeUtil.today();
    const now = timeUtil.now();
    const list = await ReservationModel.getAll(
      { student_openid: openId, date: today, status: 'pending' },
      '*',
      { create_time: 'asc' }
    );
    for (const r of list) {
      const si = timeUtil.parseSlotKey(r.slot_key);
      const startTs = timeUtil.dateMinuteToTimestamp(r.date, si.start_min);
      const endTs = timeUtil.dateMinuteToTimestamp(r.date, si.end_min);
      const winStart = startTs - config.CHECKIN_BEFORE_MIN * 60 * 1000;
      if (now >= winStart && now <= endTs) {
        return {
          res_id: r._id,
          date: r.date,
          slot_key: r.slot_key,
          venue_key: r.venue_key,
          venue_type: r.venue_type,
          venue_type_name: config.VENUE_TYPES[r.venue_type] ? config.VENUE_TYPES[r.venue_type].name : '',
          court_no: r.court_no,
          start_time: si.start_time,
          end_time: si.end_time,
          status: r.status,
          student_name: r.student_name,
        };
      }
    }
    return null;
  }
}

module.exports = CheckinService;
