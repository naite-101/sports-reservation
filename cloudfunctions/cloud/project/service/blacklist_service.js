/**
 * blacklist 业务逻辑：手动拉黑/解除/自动拉黑（爽约）
 */
const BaseService = require('./base_service.js');
const BlacklistModel = require('../model/blacklist_model.js');
const UserModel = require('../model/user_model.js');
const OperationLogModel = require('../model/operation_log_model.js');
const config = require('../../config/config.js');
const timeUtil = require('../../framework/utils/time_util.js');
const appCode = require('../../framework/core/app_code.js');

class BlacklistService extends BaseService {
  /** 黑名单列表（含历史，供审计） */
  async list() {
    return await BlacklistModel.getAll({}, '*', { create_time: 'desc' });
  }

  /**
   * 手动拉黑（自定义时长）
   * 支持用 openid / 学号 / 姓名 定位学生（姓名重复时报错，需改用学号或 openid）
   */
  async add(operator, { student_openid, student_no, name, duration_days, reason }) {
    const student = await this.resolveStudent({ student_openid, student_no, name });
    if (!student) this.AppError('学生不存在', appCode.LOGIC);
    const realOpenid = student._id;
    const days = Number(duration_days);
    if (!(days > 0)) this.AppError('拉黑时长必须大于 0 天', appCode.DATA);

    const now = timeUtil.now();
    const endTime = now + days * config.DAY_MS;
    await BlacklistModel.insert({
      student_openid: realOpenid,
      student_name: student.name || '',
      channel: 'manual',
      reason: reason || '手动拉黑',
      duration_days: days,
      start_time: now,
      end_time: endTime,
      status: 'active',
      operator_openid: operator._id,
      operator_name: operator.name || '',
      release_by_openid: '',
      release_by_name: '',
      release_time: 0,
      release_reason: '',
      create_time: now,
    });

    await this.syncUserBlackUntil(realOpenid);

    await OperationLogModel.insert({
      module: 'blacklist',
      action: 'add_blacklist',
      operator_openid: operator._id,
      operator_name: operator.name || '',
      operator_role: operator.role,
      target_openid: realOpenid,
      target_desc: student.name || realOpenid,
      detail: { channel: 'manual', duration_days: days, reason: reason || '' },
      create_time: now,
    });

    return { blacked: true, end_time: endTime };
  }

  /**
   * 按 openid -> 学号 -> 姓名 的顺序定位学生。
   * openid 查不到时回退到学号/姓名，兼容前端用单个输入框传「学号或姓名或 openid」的场景。
   */
  async resolveStudent({ student_openid, student_no, name }) {
    if (student_openid) {
      const byOpenid = await UserModel.getOne(student_openid);
      if (byOpenid) return byOpenid;
    }

    const sno = student_no || student_openid;
    if (sno) {
      const byNo = await UserModel.getOne({ student_no: sno });
      if (byNo) return byNo;
    }

    const nm = name || student_openid;
    if (nm) {
      const byName = await UserModel.getAll({ name: nm });
      if (byName.length > 1) {
        this.AppError('姓名重复，请用学号或 openid', appCode.DATA);
      }
      if (byName.length === 1) return byName[0];
    }

    return null;
  }

  /** 解除拉黑（逻辑删除保留审计）：超管(3)与人事管理员(4)均可（人事拥有超管全部权限）；普通管理员由 route 门槛拦截 */
  async release(operator, { blacklist_id, reason }) {
    const bl = await BlacklistModel.getOne(blacklist_id);
    if (!bl) this.AppError('黑名单记录不存在', appCode.LOGIC);
    if (bl.status === 'released') this.AppError('该记录已解除', appCode.LOGIC);

    const now = timeUtil.now();
    await BlacklistModel.edit(blacklist_id, {
      status: 'released',
      release_by_openid: operator._id,
      release_by_name: operator.name || '',
      release_time: now,
      release_reason: reason || '',
    });
    await this.syncUserBlackUntil(bl.student_openid);

    await OperationLogModel.insert({
      module: 'blacklist',
      action: 'release_blacklist',
      operator_openid: operator._id,
      operator_name: operator.name || '',
      operator_role: operator.role,
      target_openid: bl.student_openid,
      target_desc: bl.student_name || bl.student_openid,
      detail: { reason: reason || '' },
      create_time: now,
    });

    return { released: true };
  }

  /** 爽约自动拉黑（固定 10 天；幂等由调用方保证） */
  async applyAutoBlacklist(studentOpenid, studentName) {
    const now = timeUtil.now();
    const endTime = now + config.AUTO_BLACK_DAYS * config.DAY_MS;
    await BlacklistModel.insert({
      student_openid: studentOpenid,
      student_name: studentName || '',
      channel: 'auto',
      reason: '爽约（场次结束未签到）',
      duration_days: config.AUTO_BLACK_DAYS,
      start_time: now,
      end_time: endTime,
      status: 'active',
      operator_openid: 'system',
      operator_name: '系统',
      release_by_openid: '',
      release_by_name: '',
      release_time: 0,
      release_reason: '',
      create_time: now,
    });

    // 连续爽约取最晚到期时间
    await this.syncUserBlackUntil(studentOpenid);

    await OperationLogModel.insert({
      module: 'blacklist',
      action: 'auto_blacklist',
      operator_openid: 'system',
      operator_name: '系统',
      operator_role: 0,
      target_openid: studentOpenid,
      target_desc: studentName || studentOpenid,
      detail: { channel: 'auto', duration_days: config.AUTO_BLACK_DAYS },
      create_time: now,
    });
  }

  /** 到期自动解除：扫描 active 且 end_time<=now 的记录，原子改 released（定时任务调用，幂等） */
  async releaseExpired() {
    const now = timeUtil.now();
    const expired = await BlacklistModel.getAll(
      { status: 'active', end_time: ['<=', now] },
      '*',
      { end_time: 'asc' }
    );

    let released = 0;
    for (const bl of expired) {
      // 原子更新（幂等标记：只有成功翻转的才处理）
      const updated = await BlacklistModel.edit(
        { _id: bl._id, status: 'active' },
        {
          status: 'released',
          release_by_openid: 'system',
          release_by_name: '系统',
          release_time: now,
          release_reason: '到期自动解除',
        }
      );
      if (updated !== 1) continue;

      // 清理该用户的 black_until（若还有其他未到期拉黑则保留最晚）
      await this.syncUserBlackUntil(bl.student_openid);

      await OperationLogModel.insert({
        module: 'blacklist',
        action: 'auto_release_blacklist',
        operator_openid: 'system',
        operator_name: '系统',
        operator_role: 0,
        target_openid: bl.student_openid,
        target_desc: bl.student_name || bl.student_openid,
        detail: { channel: bl.channel, end_time: bl.end_time },
        create_time: now,
      });
      released++;
    }
    return released;
  }

  /** 重算并同步 users.black_until（取所有 active 记录的最晚到期时间） */
  async syncUserBlackUntil(studentOpenid) {
    const actives = await BlacklistModel.getAll({ student_openid: studentOpenid, status: 'active' }, 'end_time');
    let maxEnd = 0;
    for (const a of actives) {
      if (a.end_time > maxEnd) maxEnd = a.end_time;
    }
    await UserModel.edit(studentOpenid, { black_until: maxEnd, update_time: timeUtil.now() });
  }
}

module.exports = BlacklistService;
