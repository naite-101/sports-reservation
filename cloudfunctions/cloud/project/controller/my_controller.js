/**
 * my 控制器：我的预约/记录/信息
 */
const BaseController = require('./base_controller.js');
const ReservationRecordModel = require('../model/reservation_record_model.js');
const CheckinRecordModel = require('../model/checkin_record_model.js');
const UserModel = require('../model/user_model.js');
const config = require('../../config/config.js');
const timeUtil = require('../../framework/utils/time_util.js');
const appCode = require('../../framework/core/app_code.js');

class MyController extends BaseController {
  /** 我的预约列表（含取消可用标记；过期 pending 实时按「场次结束」标注为 expired，不依赖定时任务） */
  async reservations() {
    const list = await ReservationRecordModel.getAll(
      { student_openid: this._openId },
      '*',
      { create_time: 'desc' },
      100
    );
    const now = timeUtil.now();
    return list.map((r) => {
      let status = r.status;
      let cancelable = false;
      if (r.status === 'pending') {
        const si = timeUtil.parseSlotKey(r.slot_key);
        if (si) {
          const startTs = timeUtil.dateMinuteToTimestamp(r.date, si.start_min);
          const endTs = timeUtil.dateMinuteToTimestamp(r.date, si.end_min);
          if (now > endTs) {
            // 场次已结束仍未签到：按「爽约」展示（真正落库翻转由 job/expire 兜底）
            status = 'expired';
          } else {
            cancelable = now < startTs - 30 * 60 * 1000;
          }
        }
      }
      return Object.assign({}, r, { status: status, cancelable: cancelable });
    });
  }

  /** 近7天预约+签到记录（过期 pending 同样实时标注为 expired） */
  async records() {
    const from = timeUtil.addDays(timeUtil.today(), -7);
    const records = await ReservationRecordModel.getAll(
      { student_openid: this._openId, date: ['>=', from] },
      '*',
      { create_time: 'desc' },
      100
    );
    const now = timeUtil.now();
    const mapped = records.map((r) => {
      let status = r.status;
      if (r.status === 'pending') {
        const si = timeUtil.parseSlotKey(r.slot_key);
        if (si) {
          const endTs = timeUtil.dateMinuteToTimestamp(r.date, si.end_min);
          if (now > endTs) status = 'expired';
        }
      }
      return Object.assign({}, r, { status: status });
    });
    const checkins = await CheckinRecordModel.getAll(
      { student_openid: this._openId, date: ['>=', from] },
      '*',
      { checkin_time: 'desc' },
      100
    );
    return { records: mapped, checkins: checkins };
  }

  /** 我的信息 */
  async profile() {
    const user = await UserModel.getOne(this._openId);
    if (!user) this.AppError('用户不存在', appCode.NO_LOGIN);
    return {
      name: user.name,
      student_no: user.student_no,
      phone: user.phone,
      college: user.college,
      role: user.role,
      role_name: config.ROLE_LEVEL[user.role] || '',
      info_completed: user.info_completed,
      black_until: user.black_until,
    };
  }

  /** 预约统计（口径：排除已取消；爽约 = 已 expired，或仍 pending 但场次已结束） */
  async stats() {
    const now = timeUtil.now();
    const todayStr = timeUtil.today();
    const monthStart = timeUtil.dateStartTimestamp(todayStr.slice(0, 7) + '-01');

    const list = await ReservationRecordModel.getAll(
      { student_openid: this._openId },
      '*',
      { create_time: 'desc' },
      1000
    );

    let total_count = 0;
    let month_count = 0;
    let no_show_count = 0;
    for (const r of list) {
      if (r.status === 'cancelled') continue;
      total_count++;
      if ((r.create_time || 0) >= monthStart) month_count++;

      if (r.status === 'expired') {
        no_show_count++;
      } else if (r.status === 'pending') {
        const si = timeUtil.parseSlotKey(r.slot_key);
        if (si) {
          const endTs = timeUtil.dateMinuteToTimestamp(r.date, si.end_min);
          if (now > endTs) no_show_count++;
        }
      }
    }
    return { total_count: total_count, month_count: month_count, no_show_count: no_show_count };
  }
}

module.exports = MyController;
