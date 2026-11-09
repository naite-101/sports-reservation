/**
 * 场地管理（管理后台）业务逻辑
 *
 * 增量开发说明：本文件为新增文件，不修改原有签到/黑名单服务的既有逻辑。
 * 能力：
 *  1) 后台签到：管理员无需扫学生二维码，直接为当日预约用户发起签到（复用 CheckinService.checkin）；
 *  2) 拉黑用户：对已签到用户拉黑（复用 BlacklistService.add），拉黑后签到链路由 checkin_service 拦截；
 *  3) 信息查看：按日期/场馆汇总所有签到人员（主签到人 + 附属人员）基础信息；
 *  4) 附属人员补录：主签到人已签到、附属人员晚到时，管理员在后台追加（写入新增集合 checkin_companions）；
 *  5) 列表区分：主签到人 / 随行人员（扫码时登记）/ 后台补录（本页新增）三态。
 */
const BaseService = require('./base_service.js');
const CheckinRecordModel = require('../model/checkin_record_model.js');
const CheckinCompanionModel = require('../model/checkin_companion_model.js');
const ReservationModel = require('../model/reservation_model.js');
const UserModel = require('../model/user_model.js');
const BlacklistModel = require('../model/blacklist_model.js');
const QrcodeTokenModel = require('../model/qrcode_token_model.js');
const OperationLogModel = require('../model/operation_log_model.js');
const CheckinService = require('./checkin_service.js');
const BlacklistService = require('./blacklist_service.js');
const dbUtil = require('../../framework/database/db_util.js');
const config = require('../../config/config.js');
const timeUtil = require('../../framework/utils/time_util.js');
const appCode = require('../../framework/core/app_code.js');

// 补录集合懒创建标记：每个云函数实例只需探测一次，避免每次请求多一次查询
let _collectionReady = false;

/** 首次写入前确保集合存在（免去部署时手动建集合 / 重跑 init） */
async function ensureCollection() {
  if (_collectionReady) return;
  try {
    const exist = await dbUtil.isExistCollection(CheckinCompanionModel.CL);
    if (!exist) {
      try {
        await dbUtil.createCollection(CheckinCompanionModel.CL);
      } catch (e) {
        // 并发下可能已被其它实例创建，忽略
      }
    }
  } catch (e) {
    // 探测失败不阻断主流程，insert 时会暴露真实错误
  }
  _collectionReady = true;
}

/** 兼容 companions 既可能是字符串（历史/测试数据）也可能是 {name, phone} 对象 */
function companionName(c) {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c.trim();
  return String(c.name || '').trim();
}

function companionPhone(c) {
  if (!c || typeof c === 'string') return '';
  return String(c.phone || '').trim();
}

function hm(ts) {
  return ts ? timeUtil.timestamp2Time(ts, 'h:m') : '';
}

/** 当前生效中的黑名单：openid -> 最晚到期时间（一次查询，避免逐条查用户） */
async function activeBlacklistMap() {
  const now = timeUtil.now();
  const rows = await BlacklistModel.getAll(
    { status: 'active', end_time: ['>', now] },
    'student_openid,end_time'
  );
  const map = {};
  for (const r of rows) {
    const o = r.student_openid;
    if (!o) continue;
    if (!map[o] || r.end_time > map[o]) map[o] = r.end_time;
  }
  return map;
}

/** 批量取用户资料（手机号/学院），用于「信息查看」 */
async function userMapOf(openids) {
  const ids = Array.from(new Set((openids || []).filter(Boolean)));
  if (!ids.length) return {};
  const rows = await UserModel.getAll({ _id: ['in', ids] });
  const map = {};
  for (const u of rows) map[u._id] = u;
  return map;
}

class VenueManageService extends BaseService {
  /**
   * 签到人员列表（按主签到人分组，自带附属人员）
   * @param {object} p { date, venue_type, slot_key, keyword }
   */
  async checkinList({ date, venue_type, slot_key, keyword } = {}) {
    // 首次访问时确保补录集合存在，避免新环境查询不存在的集合报错
    await ensureCollection();

    const day = date || timeUtil.today();
    const where = { date: day };
    if (venue_type) where.venue_type = venue_type;
    if (slot_key) where.slot_key = slot_key;

    const records = await CheckinRecordModel.getAll(where, '*', { checkin_time: 'desc' });
    const ids = records.map((r) => r._id);

    const supplements = ids.length
      ? await CheckinCompanionModel.getAll({ checkin_id: ['in', ids] }, '*', { add_time: 'asc' })
      : [];
    const byCheckin = {};
    for (const s of supplements) {
      if (!byCheckin[s.checkin_id]) byCheckin[s.checkin_id] = [];
      byCheckin[s.checkin_id].push(s);
    }

    const blMap = await activeBlacklistMap();
    const userMap = await userMapOf(records.map((r) => r.student_openid));
    const kw = String(keyword || '').trim().toLowerCase();

    const list = [];
    let onsiteCount = 0;
    let adminCount = 0;

    for (const r of records) {
      const u = userMap[r.student_openid] || {};
      const mainName = r.student_name || u.name || '';
      const mainNo = r.student_no || u.student_no || '';
      const mainPhone = u.phone || '';

      // 1) 扫码签到时登记的随行人员（原有数据结构，不改动）
      const onsite = (Array.isArray(r.companions) ? r.companions : [])
        .map((c, i) => ({
          id: 'onsite_' + r._id + '_' + i,
          name: companionName(c),
          student_no: '',
          college: '',
          phone: companionPhone(c),
          source: 'onsite',
          source_text: '随行人员',
          add_method: 'onsite',
          remark: '',
          add_time: r.checkin_time || 0,
          add_time_text: hm(r.checkin_time),
          operator_name: r.admin_name || '',
          removable: false,
        }))
        .filter((c) => c.name);

      // 2) 管理员后台扫码补录的附属人员（新增集合）
      const adminAdded = (byCheckin[r._id] || []).map((s) => ({
        id: s._id,
        name: s.name || '',
        student_no: s.student_no || '',
        college: s.college || '',
        phone: s.phone || '',
        source: 'admin',
        source_text: '后台补录',
        add_method: s.add_method || 'scan',
        remark: s.remark || '',
        add_time: s.add_time || 0,
        add_time_text: hm(s.add_time),
        operator_name: s.operator_name || '',
        removable: true,
      }));

      const companions = onsite.concat(adminAdded);

      if (kw) {
        const hay = [mainName, mainNo, mainPhone]
          .concat(companions.map((c) => c.name + ' ' + c.phone))
          .join(' ')
          .toLowerCase();
        if (hay.indexOf(kw) < 0) continue;
      }

      const si = timeUtil.parseSlotKey(r.slot_key) || {};
      const blackUntil = blMap[r.student_openid] || 0;

      onsiteCount += onsite.length;
      adminCount += adminAdded.length;

      list.push({
        checkin_id: r._id,
        res_id: r.res_id || r._id,
        date: r.date,
        slot_key: r.slot_key,
        slot_text: si.start_time ? si.start_time + '~' + si.end_time : r.slot_key,
        venue_type: r.venue_type,
        venue_type_name: r.venue_type_name || '',
        venue_key: r.venue_key,
        court_no: r.court_no,
        venue_text: ((r.venue_type_name || '') + (r.court_no ? ' ' + r.court_no + ' 号' : '')).trim(),
        checkin_time: r.checkin_time || 0,
        checkin_time_text: hm(r.checkin_time),
        checked_by: r.admin_name || '',
        main: {
          openid: r.student_openid,
          name: mainName,
          student_no: mainNo,
          phone: mainPhone,
          college: u.college || '',
          is_blacklisted: !!blackUntil,
          black_until_text: blackUntil ? timeUtil.timestamp2Time(blackUntil, 'Y-M-D') : '',
        },
        companions,
        onsite_count: onsite.length,
        admin_count: adminAdded.length,
        people_count: 1 + companions.length,
      });
    }

    return {
      date: day,
      list,
      stats: {
        main: list.length,
        onsite: onsiteCount,
        admin: adminCount,
        total: list.length + onsiteCount + adminCount,
      },
    };
  }

  /**
   * 后台签到候选：当日待签到预约（不扫二维码）
   * 返回窗口状态，前端据此置灰按钮，避免管理员误操作
   */
  async pendingList({ date, venue_type, slot_key, keyword } = {}) {
    const day = date || timeUtil.today();
    const where = { date: day, status: 'pending' };
    if (venue_type) where.venue_type = venue_type;
    if (slot_key) where.slot_key = slot_key;

    const rows = await ReservationModel.getAll(where, '*', { slot_key: 'asc', venue_key: 'asc' });
    const blMap = await activeBlacklistMap();
    const userMap = await userMapOf(rows.map((r) => r.student_openid));
    const now = timeUtil.now();
    const kw = String(keyword || '').trim().toLowerCase();

    const list = [];
    for (const r of rows) {
      const u = userMap[r.student_openid] || {};
      const name = r.student_name || u.name || '';
      const no = r.student_no || u.student_no || '';
      const phone = u.phone || '';

      if (kw && (name + ' ' + no + ' ' + phone).toLowerCase().indexOf(kw) < 0) continue;

      const si = timeUtil.parseSlotKey(r.slot_key) || {};
      const startTs = si.start_min === undefined ? 0 : timeUtil.dateMinuteToTimestamp(r.date, si.start_min);
      const endTs = si.end_min === undefined ? 0 : timeUtil.dateMinuteToTimestamp(r.date, si.end_min);
      const winStart = startTs - config.CHECKIN_BEFORE_MIN * 60 * 1000;
      const blackUntil = blMap[r.student_openid] || 0;

      let state = 'open';
      let stateText = '可签到';
      let can = true;
      if (!startTs) {
        state = 'invalid';
        stateText = '场次异常';
        can = false;
      } else if (blackUntil > now) {
        state = 'blocked';
        stateText = '已被拉黑';
        can = false;
      } else if (now < winStart) {
        state = 'too_early';
        stateText = '未到签到时间';
        can = false;
      } else if (now > endTs) {
        state = 'ended';
        stateText = '场次已结束';
        can = false;
      }

      list.push({
        res_id: r._id,
        date: r.date,
        slot_key: r.slot_key,
        slot_text: si.start_time ? si.start_time + '~' + si.end_time : r.slot_key,
        start_ts: startTs,
        venue_type: r.venue_type,
        venue_type_name: r.venue_type_name || '',
        venue_key: r.venue_key,
        court_no: r.court_no,
        venue_text: ((r.venue_type_name || '') + (r.court_no ? ' ' + r.court_no + ' 号' : '')).trim(),
        student_name: name,
        student_no: no,
        phone,
        college: u.college || '',
        is_blacklisted: !!blackUntil,
        state,
        state_text: stateText,
        can_checkin: can,
      });
    }

    // 可签到的排前面，其次按场次时间升序
    list.sort((a, b) => {
      const d = (b.can_checkin ? 1 : 0) - (a.can_checkin ? 1 : 0);
      return d !== 0 ? d : a.start_ts - b.start_ts;
    });

    return {
      date: day,
      list,
      can_count: list.filter((x) => x.can_checkin).length,
    };
  }

  /**
   * 后台签到（管理员直接为用户发起，无需扫二维码）
   * 时间窗口、闭馆、幂等、流水与日志全部复用原有 CheckinService，保证与扫码签到一致
   */
  async checkin(operator, { res_id, slot_key }) {
    const res = await ReservationModel.getOne(res_id);
    if (!res) this.AppError('预约不存在或已取消', appCode.NO_VALID_BOOKING);

    if (res.status === 'checked_in') {
      const rec = await CheckinRecordModel.getOne(res_id);
      return { already: true, checkin_time: rec ? rec.checkin_time : res.checkin_time || 0 };
    }

    // 黑名单前置校验：给出剩余天数的友好提示（checkin_service 内亦有一道兜底校验）
    const user = await UserModel.getOne(res.student_openid);
    const now = timeUtil.now();
    if (user && user.black_until && user.black_until > now) {
      const days = Math.ceil((user.black_until - now) / config.DAY_MS);
      this.AppError('该用户已被拉黑（剩余 ' + days + ' 天），无法签到', appCode.BLACKLIST, { black_days: days });
    }

    return await new CheckinService().checkin(operator, {
      res_id: res_id,
      slot_key: slot_key || res.slot_key,
      companions: [],
    });
  }

  /**
   * 附属人员补录：扫描对方的「个人二维码」识别身份后直接登记
   * - 校验动态二维码有效性与学生身份，管理员无需手输姓名/电话
   * - 只写新增集合，不改动原 checkin_records.companions
   */
  async companionScan(operator, { token, checkin_id }) {
    await ensureCollection();

    const now = timeUtil.now();

    // 1. 二维码 token 校验（20 秒动态码，防截图复用）
    const tokenDoc = await QrcodeTokenModel.getOne({ token: String(token || '').trim() });
    if (!tokenDoc) {
      this.AppError('无法识别该二维码，请扫描学生的个人签到码', appCode.DATA);
    }
    if (!tokenDoc.expire_time || tokenDoc.expire_time <= now) {
      this.AppError('二维码已过期，请让对方刷新二维码后重试', appCode.QR_EXPIRED);
    }

    // 2. 目标签到记录
    const rec = await CheckinRecordModel.getOne(checkin_id);
    if (!rec) this.AppError('签到记录不存在，请先完成主签到', appCode.NO_VALID_BOOKING);

    // 3. 扫码人身份
    const companionOpenid = tokenDoc.student_openid;
    if (!companionOpenid) this.AppError('二维码信息不完整，请让对方刷新后重试', appCode.DATA);
    if (companionOpenid === rec.student_openid) {
      this.AppError('这是主签到人本人的二维码，无需补录', appCode.LOGIC);
    }

    const student = await UserModel.getOne(companionOpenid);
    if (!student) this.AppError('该二维码对应的学生不存在', appCode.LOGIC);

    if (student.black_until && student.black_until > now) {
      const days = Math.ceil((student.black_until - now) / config.DAY_MS);
      this.AppError('该同学已被拉黑（剩余 ' + days + ' 天），无法补录', appCode.BLACKLIST, { black_days: days });
    }

    // 4. 重复校验：同一 openid 已补录 / 姓名已在现场随行名单中
    const nm = String(student.name || '').trim() || '未填写姓名';
    const onsiteNames = (Array.isArray(rec.companions) ? rec.companions : []).map(companionName).filter(Boolean);
    if (onsiteNames.indexOf(nm) >= 0) {
      this.AppError('「' + nm + '」已在现场随行人员中登记，请勿重复补录', appCode.LOGIC);
    }
    const existed = await CheckinCompanionModel.getAll({ checkin_id: checkin_id }, 'companion_openid');
    if (existed.some((x) => x.companion_openid === companionOpenid)) {
      this.AppError('「' + nm + '」已补录，请勿重复扫码', appCode.LOGIC);
    }

    // 5. 写入补录记录
    const si = timeUtil.parseSlotKey(rec.slot_key) || {};
    const doc = {
      checkin_id: checkin_id,
      res_id: rec.res_id || checkin_id,
      date: rec.date,
      slot_key: rec.slot_key,
      venue_key: rec.venue_key,
      venue_type: rec.venue_type,
      venue_type_name: rec.venue_type_name || '',
      court_no: rec.court_no,
      main_openid: rec.student_openid,
      main_name: rec.student_name || '',
      main_student_no: rec.student_no || '',
      companion_openid: companionOpenid,
      name: nm,
      student_no: student.student_no || '',
      college: student.college || '',
      phone: student.phone || '',
      remark: '',
      source: 'admin',
      add_method: 'scan',
      operator_openid: operator._id,
      operator_name: operator.name || '',
      add_time: now,
    };
    const id = await CheckinCompanionModel.insert(doc);

    await OperationLogModel.insert({
      module: 'venue_manage',
      action: 'companion_add',
      operator_openid: operator._id,
      operator_name: operator.name || '',
      operator_role: operator.role,
      target_openid: companionOpenid,
      target_desc: rec.date + ' ' + (si.start_time || rec.slot_key) + ' ' + (rec.venue_key || '') + ' 扫码补录 ' + nm,
      detail: {
        checkin_id: checkin_id,
        companion_openid: companionOpenid,
        name: nm,
        student_no: student.student_no || '',
        venue_key: rec.venue_key,
      },
      create_time: now,
    });

    return {
      companion_id: id,
      add_time: now,
      name: nm,
      student_no: student.student_no || '',
      college: student.college || '',
      phone: student.phone || '',
    };
  }

  /** 删除后台补录的附属人员（现场随行人员属于原签到记录，不在此处改动） */
  async companionRemove(operator, { companion_id }) {
    await ensureCollection();

    const c = await CheckinCompanionModel.getOne(companion_id);
    if (!c) this.AppError('补录记录不存在', appCode.LOGIC);
    if (c.source !== 'admin') this.AppError('仅支持删除后台补录的附属人员', appCode.LOGIC);

    const now = timeUtil.now();
    await CheckinCompanionModel.del(companion_id);

    await OperationLogModel.insert({
      module: 'venue_manage',
      action: 'companion_remove',
      operator_openid: operator._id,
      operator_name: operator.name || '',
      operator_role: operator.role,
      target_openid: c.main_openid || '',
      target_desc: (c.date || '') + ' 删除补录 ' + (c.name || ''),
      detail: { checkin_id: c.checkin_id, name: c.name },
      create_time: now,
    });

    return { removed: true };
  }

  /**
   * 拉黑签到用户（仅限已完成签到的用户，与场地管理列表一致）
   * 拉黑后签到链路由 checkin_service 统一拦截
   * 复用 BlacklistService.add：写黑名单 + 同步 users.black_until + 操作日志
   */
  async blockUser(operator, { checkin_id, duration_days, reason }) {
    const now = timeUtil.now();

    const rec = await CheckinRecordModel.getOne(checkin_id);
    if (!rec) this.AppError('签到记录不存在', appCode.NO_VALID_BOOKING);

    const openid = rec.student_openid;
    const name = rec.student_name || '';
    if (!openid) this.AppError('签到记录缺少用户信息', appCode.DATA);

    const user = await UserModel.getOne(openid);
    if (!user) this.AppError('用户不存在', appCode.LOGIC);

    if (user.black_until && user.black_until > now) {
      const days = Math.ceil((user.black_until - now) / config.DAY_MS);
      this.AppError('该用户已在黑名单中（剩余 ' + days + ' 天）', appCode.BLACKLIST, { black_days: days });
    }

    const days = Math.min(365, Math.max(1, Number(duration_days) || 7));
    const r = await new BlacklistService().add(operator, {
      student_openid: openid,
      duration_days: days,
      reason: reason || '场地管理-现场拉黑',
    });

    return {
      end_time: r.end_time,
      duration_days: days,
      student_name: name || user.name || '',
    };
  }
}

module.exports = VenueManageService;
