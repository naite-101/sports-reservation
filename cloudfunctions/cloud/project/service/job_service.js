/**
 * job 业务逻辑：爽约定时拉黑（幂等）/ 预约提醒（P1）
 */
const BaseService = require('./base_service.js');
const ReservationRecordModel = require('../model/reservation_record_model.js');
const ReservationModel = require('../model/reservation_model.js');
const BlacklistService = require('./blacklist_service.js');
const MessageService = require('./message_service.js');
const timeUtil = require('../../framework/utils/time_util.js');
const config = require('../../config/config.js');

class JobService extends BaseService {
  /**
   * 爽约扫描：最近2天 status=pending 且场次已结束 -> 原子更新 expired -> 自动拉黑10天
   * 并顺带执行黑名单到期自动解除（status=active 且 end_time<=now -> released）
   * 幂等：以 update pending->expired / active->released 成功为标记
   */
  async expire() {
    const now = timeUtil.now();
    const today = timeUtil.today();
    const fromDate = timeUtil.addDays(today, -2);

    const records = await ReservationRecordModel.getAll(
      { status: 'pending', date: ['>=', fromDate] },
      '*',
      { date: 'asc' }
    );

    const blacklistService = new BlacklistService();
    let processed = 0;

    for (const r of records) {
      const si = timeUtil.parseSlotKey(r.slot_key);
      if (!si) continue;
      const endTs = timeUtil.dateMinuteToTimestamp(r.date, si.end_min);
      if (now <= endTs) continue; // 场次未结束

      // 原子更新（幂等关键：只有成功翻转的才处理）
      const updated = await ReservationRecordModel.edit(
        { _id: r._id, status: 'pending' },
        { status: 'expired', update_time: now }
      );
      if (updated === 1) {
        await blacklistService.applyAutoBlacklist(r.student_openid, r.student_name);
        processed++;
        // 同步释放实时占用表 reservations（避免该场地长期处于「已约」状态）
        try {
          await ReservationModel.del(r.res_id);
        } catch (e) {
          console.error('[expire] 释放占用失败 res_id=' + r.res_id, e);
        }
      }
    }

    // 黑名单到期自动解除
    const released = await blacklistService.releaseExpired();

    return { processed: processed, released_blacklist: released, scan_from: fromDate };
  }

  /**
   * 预约即将开始提醒（P1 基础实现：查找 30 分钟内开始的今日 pending 预约）
   * 去重：reservation_records.notified=1 标记已提醒，避免 5 分钟周期重复推送
   */
  async notify() {
    const now = timeUtil.now();
    const today = timeUtil.today();
    const list = await ReservationRecordModel.getAll(
      { date: today, status: 'pending' },
      '*',
      { create_time: 'asc' }
    );

    const messageService = new MessageService();
    let sent = 0;
    for (const r of list) {
      if (r.notified) continue; // 已提醒过，跳过
      const si = timeUtil.parseSlotKey(r.slot_key);
      if (!si) continue;
      const startTs = timeUtil.dateMinuteToTimestamp(r.date, si.start_min);
      const diff = startTs - now;
      if (diff > 0 && diff <= 30 * 60 * 1000) {
        const ok = await messageService.sendSubscribe(r.student_openid, 'remind', 'pages/qrcode/qrcode', {
          thing1: { value: '场地预约即将开始' },
          time2: { value: timeUtil.timestamp2Time(startTs, 'h:m') },
        });
        if (ok) {
          // 标记已提醒（原子条件：仅 pending 才置位，防止与取消/签到竞态）
          const marked = await ReservationRecordModel.edit(
            { _id: r._id, status: 'pending' },
            { notified: 1, update_time: now }
          );
          if (marked === 1) sent++;
        }
      }
    }
    return { sent: sent };
  }
}

module.exports = JobService;
