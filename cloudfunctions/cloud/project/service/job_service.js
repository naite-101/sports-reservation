/**
 * job 业务逻辑：爽约定时拉黑（幂等）/ 预约提醒（P1）
 */
const BaseService = require('./base_service.js');
const ReservationRecordModel = require('../model/reservation_record_model.js');
const ReservationModel = require('../model/reservation_model.js');
const StudentSlotLockModel = require('../model/student_slot_lock_model.js');
const AntiAbuseModel = require('../model/anti_abuse_model.js');
const BlacklistService = require('./blacklist_service.js');
const MessageService = require('./message_service.js');
const timeUtil = require('../../framework/utils/time_util.js');
const config = require('../../config/config.js');

class JobService extends BaseService {
  /**
   * 爽约扫描：所有「日期 <= 今天」且 status=pending 且场次已结束 -> 原子更新 expired -> 自动拉黑10天
   * 并顺带执行黑名单到期自动解除（status=active 且 end_time<=now -> released）
   * 幂等：以 update pending->expired / active->released 成功为标记
   * 说明：早先限定「最近2天」，导致更早的过期预约永远无法翻转为 expired（爽约次数恒为 0），
   *       现改为扫描今天及之前的所有 pending，由「场次结束时间 <= now」这一条件兜底判断。
   */
  async expire() {
    const now = timeUtil.now();
    const today = timeUtil.today();

    const records = await ReservationRecordModel.getAll(
      { status: 'pending', date: ['<=', today] },
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
        // 同步释放实时占用表 reservations（避免该场地长期处于「已约」状态）+ 学生时段锁
        try {
          await ReservationModel.del(r.res_id);
          await StudentSlotLockModel.del(StudentSlotLockModel.key(r.student_openid, r.date, r.slot_key));
        } catch (e) {
          console.error('[expire] 释放占用失败 res_id=' + r.res_id, e);
        }
      }
    }

    // 黑名单到期自动解除
    const released = await blacklistService.releaseExpired();

    // M-9：孤儿锁清扫——锁对应流水已取消/过期（或流水不存在）时释放，
    //      避免学生该时段永久 4101「已预约其他场地」。
    //      注意：checked_in 的锁须等场次结束再清（签到窗口早于开场 15 分钟，
    //      此窗口内 create 仍放行，提前清锁会导致同场次重复预约）。
    const orphanLocks = await StudentSlotLockModel.getAll({}, '*', { create_time: 'asc' });
    let locksCleaned = 0;
    for (const lk of orphanLocks) {
      try {
        const rec = await ReservationRecordModel.getOne({ res_id: lk.res_id });
        let orphan = false;
        if (!rec || rec.status === 'cancelled' || rec.status === 'expired') {
          orphan = true;
        } else if (rec.status === 'pending') {
          // 流水仍待签到但占用文档已丢失（极端残留）：锁失去意义，一并清扫
          const resDoc = await ReservationModel.getOne(lk.res_id);
          orphan = !resDoc;
        } else if (rec.status === 'checked_in') {
          const si = timeUtil.parseSlotKey(rec.slot_key);
          const endTs = si ? timeUtil.dateMinuteToTimestamp(rec.date, si.end_min) : 0;
          orphan = !endTs || now > endTs;
        }
        if (orphan) {
          await StudentSlotLockModel.del(lk._id);
          locksCleaned++;
        }
      } catch (e) {
        console.error('[expire] 孤儿锁清扫失败 lock_id=' + lk._id, e);
      }
    }

    // L-4：清理已完成生命周期的 checked_in 占用文档（日期<=昨天；流水保留不动），避免占用表只增不减
    const yesterday = timeUtil.today(); // 占用只服务「当天/次日」预约，date<今天即无展示价值
    let staleCleaned = 0;
    try {
      staleCleaned = await ReservationModel.del({ status: 'checked_in', date: ['<', yesterday] });
    } catch (e) {
      console.error('[expire] 过期占用清理失败', e);
    }

    // L-2：清理过期限流记录，防止 anti_abuse 集合无限膨胀
    const dayAgo = now - config.DAY_MS;
    try {
      await AntiAbuseModel.del({ create_time: ['<', dayAgo] });
    } catch (e) {
      console.error('[expire] 限流记录清理失败', e);
    }

    return {
      processed: processed,
      released_blacklist: released,
      locks_cleaned: locksCleaned,
      stale_reservations_cleaned: staleCleaned,
      scan_up_to: today,
    };
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
