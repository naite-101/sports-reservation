/**
 * 云端冒烟测试服务（smoke/run 专用，受 job_secret 保护）
 * 目的：在「真实云端环境」验证部署完整性，而非本地 mock。
 * 覆盖：
 *   1. 集合是否齐全（11 个）
 *   2. 场馆/场次/配置是否初始化
 *   3. reservations._id 组合主键是否真实防超约（并发插入同一 _id，只 1 成功）
 *   4. uniq_student_slot 唯一索引是否生效（同一学生同时间窗约不同场地）
 *   5. 预约→释放→再约 完整事务链路
 *
 * 注意：本脚本只做「受控、可回滚」的探测，用完即清理测试数据，不污染线上。
 */
const BaseService = require('./base_service.js');
const config = require('../../config/config.js');
const dbUtil = require('../../framework/database/db_util.js');
const timeUtil = require('../../framework/utils/time_util.js');
const ReservationModel = require('../model/reservation_model.js');
const VenueModel = require('../model/venue_model.js');
const TimeSlotModel = require('../model/time_slot_model.js');
const ConfigModel = require('../model/config_model.js');
const UserModel = require('../model/user_model.js');

class SmokeService extends BaseService {
  async run() {
    const results = [];
    const add = (name, ok, detail) => results.push({ name, ok, detail });

    // ---------- 1. 集合齐全性 ----------
    try {
      const missing = [];
      for (const name of Object.values(config.COLLECTION)) {
        const ok = await dbUtil.isExistCollection(name);
        if (!ok) missing.push(name);
      }
      add('集合齐全(11个)', missing.length === 0, missing.length ? '缺失: ' + missing.join(', ') : '全部存在');
    } catch (e) {
      add('集合齐全(11个)', false, '检查异常: ' + (e.message || e));
    }

    // ---------- 2. 初始化数据 ----------
    try {
      const venues = await VenueModel.count({});
      const slots = await TimeSlotModel.count({});
      const cfg = await ConfigModel.getOne('open_time');
      add('初始化数据(场馆/场次/配置)', venues > 0 && slots > 0 && !!cfg,
        '场馆=' + venues + ' 场次=' + slots + ' open_time=' + (cfg ? JSON.stringify(cfg.value) : '缺失'));
    } catch (e) {
      add('初始化数据(场馆/场次/配置)', false, '检查异常: ' + (e.message || e));
    }

    // ---------- 3. 组合主键防超约（真实并发插入同一 _id） ----------
    // 用「明天」某个真实开放的场次 + 一个不存在的场地 key，构造唯一 resId
    const tomorrow = timeUtil.tomorrow();
    const weekend = timeUtil.isWeekend(tomorrow);
    const slot = await TimeSlotModel.getAll({}, '*', { sort: 'asc' });
    const usableSlot = slot.find((s) => s.day_type === 'all' || s.day_type === (weekend ? 'weekend' : 'weekday'));
    const venue = await VenueModel.getOne({ closed: false });
    const testResId = 'SMOKE_' + tomorrow + '_' + (usableSlot ? usableSlot.slot_key : '1300_1410') + '_' + (venue ? venue.venue_key : 'badminton#1');

    let pkOk = false;
    let pkDetail = '';
    try {
      const ins = (openid) => dbUtil.insert(config.COLLECTION.reservations, {
        _id: testResId,
        student_openid: openid,
        student_name: 'smoke',
        date: tomorrow,
        slot_key: usableSlot ? usableSlot.slot_key : '1300_1410',
        venue_key: venue ? venue.venue_key : 'badminton#1',
        status: 'pending',
        create_time: timeUtil.now(),
      });
      // 并发插入同一 _id，期望只有 1 个成功，其余抛「已存在」异常
      const attempt = async (openid) => {
        try { await ins(openid); return 'ok'; } catch (e) { return 'dup'; }
      };
      const r = await Promise.all([attempt('smoke_a'), attempt('smoke_b'), attempt('smoke_c')]);
      const okCount = r.filter((x) => x === 'ok').length;
      pkOk = okCount === 1;
      pkDetail = '3次并发插入同一_id，成功=' + okCount + ' 被拒=' + (3 - okCount) + '（期望 1 / 2）';
    } catch (e) {
      pkDetail = '执行异常: ' + (e.message || e);
    } finally {
      // 清理测试数据
      await dbUtil.del(config.COLLECTION.reservations, { _id: testResId }).catch(() => {});
    }
    add('组合主键防超约(同一_id并发只1成功)', pkOk, pkDetail);

    // ---------- 4. uniq_student_slot 唯一索引是否生效 ----------
    // 同一学生（smoke_user）同一 date+slot_key，先后约两个不同场地。
    // 若索引已建，第二次 add 会因唯一约束失败；若索引缺失，会成功（暴露问题）。
    let idxOk = false;
    let idxDetail = '';
    const idxUser = 'smoke_user_' + Date.now();
    const resA = 'SMOKE_IDX_' + tomorrow + '_' + (usableSlot ? usableSlot.slot_key : '1300_1410') + '_badminton#1';
    const resB = 'SMOKE_IDX_' + tomorrow + '_' + (usableSlot ? usableSlot.slot_key : '1300_1410') + '_badminton#2';
    try {
      await dbUtil.insert(config.COLLECTION.reservations, {
        _id: resA, student_openid: idxUser, date: tomorrow,
        slot_key: usableSlot ? usableSlot.slot_key : '1300_1410', venue_key: 'badminton#1',
        status: 'pending', create_time: timeUtil.now(),
      });
      let secondOk = false;
      try {
        await dbUtil.insert(config.COLLECTION.reservations, {
          _id: resB, student_openid: idxUser, date: tomorrow,
          slot_key: usableSlot ? usableSlot.slot_key : '1300_1410', venue_key: 'badminton#2',
          status: 'pending', create_time: timeUtil.now(),
        });
        secondOk = true;
      } catch (e) { secondOk = false; }
      // secondOk === false 说明唯一索引拦截成功；true 说明索引缺失（同学生同窗跨场地约了2个）
      idxOk = !secondOk;
      idxDetail = secondOk ? '⚠ 第二次约不同场地成功 → uniq_student_slot 索引可能缺失！' : '第二次约不同场地被拒 → 索引已生效';
    } catch (e) {
      idxDetail = '执行异常: ' + (e.message || e);
    } finally {
      await dbUtil.del(config.COLLECTION.reservations, { _id: resA }).catch(() => {});
      await dbUtil.del(config.COLLECTION.reservations, { _id: resB }).catch(() => {});
    }
    add('uniq_student_slot 唯一索引', idxOk, idxDetail);

    // ---------- 5. 预约→释放→再约 完整链路（用真实业务 service） ----------
    let chainOk = false;
    let chainDetail = '';
    try {
      const ReservationService = require('./reservation_service.js');
      const svc = new ReservationService();
      // 造一个「已完善信息」的临时用户
      const fakeUser = {
        openid: idxUser, name: '冒烟', student_no: 'SMOKE001', phone: '13800000000',
        college: '测试', info_completed: true, role: 1, status: 1, black_until: 0,
      };
      // 选一个明天开放的、且 start_min > 当前分钟 的场次（否则会被"已开始"拦截）
      // 确定「现在允许预约的日期」：未到开放时刻(默认21:00)只能约今天，已过只能约明天
      const openTime = await new ReservationService().getOpenTime();
      const openMin = (Number(openTime.hour) || 0) * 60 + (Number(openTime.minute) || 0);
      const nowMin = timeUtil.nowMinutes();
      const bookDate = nowMin < openMin ? timeUtil.today() : timeUtil.tomorrow();
      const bookWeekend = timeUtil.isWeekend(bookDate);

      const bookSlot = slot.find((s) =>
        (s.day_type === 'all' || s.day_type === (bookWeekend ? 'weekend' : 'weekday')) &&
        s.start_min > nowMin
      ) || usableSlot;
      const bookVenue = venue ? venue.venue_key : 'badminton#1';

      if (!bookSlot) {
        chainDetail = '无可用未来场次，跳过链路测试';
      } else {
        const created = await svc.create(idxUser, fakeUser, {
          date: bookDate, slot_key: bookSlot.slot_key, venue_key: bookVenue,
        });
        const resId = created && created.res_id ? created.res_id : (bookDate + '_' + bookSlot.slot_key + '_' + bookVenue);
        // 释放
        await svc.cancel(idxUser, { res_id: resId });
        // 再约同场地应成功（证明释放后释放了占用）
        await svc.create(idxUser, fakeUser, {
          date: bookDate, slot_key: bookSlot.slot_key, venue_key: bookVenue,
        });
        chainOk = true;
        chainDetail = '预约→取消→再约 成功（场地释放后再次占用正常）';
        // 清理
        await svc.cancel(idxUser, { res_id: resId }).catch(() => {});
        await dbUtil.del(config.COLLECTION.reservations, { _id: resId }).catch(() => {});
        await dbUtil.del(config.COLLECTION.reservation_records, { student_openid: idxUser }).catch(() => {});
      }
    } catch (e) {
      chainDetail = '链路异常: ' + (e.message || e) + ' (code=' + (e.code || '') + ')';
    }
    add('预约→释放→再约 完整链路', chainOk, chainDetail);

    const passed = results.filter((r) => r.ok).length;
    return {
      passed: passed,
      total: results.length,
      all_ok: passed === results.length,
      results: results,
    };
  }
}

module.exports = SmokeService;
