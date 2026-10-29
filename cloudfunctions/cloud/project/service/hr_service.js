/**
 * hr 业务逻辑：人事管理（老师/主席）
 */
const BaseService = require('./base_service.js');
const UserModel = require('../model/user_model.js');
const OperationLogModel = require('../model/operation_log_model.js');
const config = require('../../config/config.js');
const timeUtil = require('../../framework/utils/time_util.js');
const appCode = require('../../framework/core/app_code.js');

class HrService extends BaseService {
  /** 管理员列表（role>=2） */
  async adminList() {
    return await UserModel.getAll({ role: ['>=', config.ROLE.ADMIN] }, '*', { role: 'desc', create_time: 'asc' });
  }

  /**
   * 任命权限规则（bug 修复）：
   * - 超级管理员(3)：只能任命普通管理员(2)
   * - 人事管理员（老师4 / 主席5）：可任命普通管理员(2)、超级管理员(3)、人事管理员(4/5)
   * - 其他角色：无任命权
   * @returns 可任命的目标角色数组；空数组表示无权任命
   */
  assignableRoles(operatorRole) {
    operatorRole = Number(operatorRole);
    if (operatorRole === config.ROLE.SUPER_ADMIN) {
      return [config.ROLE.ADMIN];
    }
    if (operatorRole === config.ROLE.TEACHER || operatorRole === config.ROLE.CHAIRMAN) {
      return [config.ROLE.ADMIN, config.ROLE.SUPER_ADMIN, config.ROLE.TEACHER, config.ROLE.CHAIRMAN];
    }
    return [];
  }

  /** 校验操作者是否有权任命目标角色，无权则抛 NO_RIGHT */
  assertCanAssign(operator, targetRole) {
    const allowed = this.assignableRoles(operator.role);
    if (allowed.indexOf(Number(targetRole)) < 0) {
      this.AppError('您无权任命该角色', appCode.NO_RIGHT);
    }
  }

  /** 任免/新增管理员 */
  async adminAdd(operator, { openid, role, name }) {
    role = Number(role);
    // 目标角色必须是合法管理员角色（2/3/4/5）
    if ([config.ROLE.ADMIN, config.ROLE.SUPER_ADMIN, config.ROLE.TEACHER, config.ROLE.CHAIRMAN].indexOf(role) < 0) {
      this.AppError('仅可任命普通管理员、超级管理员或人事管理员', appCode.DATA);
    }
    // 按操作者权限校验（bug 修复：超管仅能任命普通管理员；人事管理员可任命到人事管理员）
    this.assertCanAssign(operator, role);
    const now = timeUtil.now();
    const user = await UserModel.getOne(openid);
    if (!user) {
      await UserModel.insert({
        _id: openid,
        openid: openid,
        role: role,
        name: name || '',
        student_no: '',
        phone: '',
        college: '',
        info_completed: false,
        status: 1,
        black_until: 0,
        create_time: now,
        update_time: now,
      });
    } else {
      await UserModel.edit(openid, { role: role, name: name || user.name, status: 1, update_time: now });
    }
    await this._log(operator, 'assign_admin', openid, name || openid, { role: role });
    return { assigned: true };
  }

  /** 移除管理员（降级为学生） */
  async adminRemove(operator, { openid }) {
    const user = await UserModel.getOne(openid);
    if (!user) this.AppError('用户不存在', appCode.LOGIC);
    // 只能操作权限低于自己的成员，否则老师可直接把主席降为学生
    if (Number(user.role) >= Number(operator.role)) {
      this.AppError('不能移除同级或更高权限的成员', appCode.NO_RIGHT);
    }
    await UserModel.edit(openid, { role: config.ROLE.STUDENT, status: 1, update_time: timeUtil.now() });
    await this._log(operator, 'remove_admin', openid, user.name || openid, { from_role: user.role });
    return { removed: true };
  }

  /** 分配/调整/禁用权限 */
  async adminAssign(operator, { openid, role, status }) {
    role = Number(role);
    if ([config.ROLE.ADMIN, config.ROLE.SUPER_ADMIN, config.ROLE.TEACHER, config.ROLE.CHAIRMAN].indexOf(role) < 0) {
      this.AppError('权限等级不合法', appCode.DATA);
    }
    // 按操作者权限校验（bug 修复：与 adminAdd 一致）
    this.assertCanAssign(operator, role);
    const user = await UserModel.getOne(openid);
    if (!user) this.AppError('用户不存在', appCode.LOGIC);

    const data = { role: role, update_time: timeUtil.now() };
    if (status === 0 || status === 1) data.status = status;
    await UserModel.edit(openid, data);
    await this._log(operator, 'assign_admin', openid, user.name || openid, { role: role, status: data.status });
    return { assigned: true };
  }

  /** 学生名单 */
  async studentList({ keyword, page = 1, size = 20 }) {
    let where = { role: config.ROLE.STUDENT };
    if (keyword) {
      where = {
        role: config.ROLE.STUDENT,
        or: [{ name: ['like', keyword] }, { student_no: ['like', keyword] }],
      };
    }
    return await UserModel.getList(where, '*', { create_time: 'desc' }, page, size);
  }

  /** 学生详情 */
  async studentDetail(openid) {
    const user = await UserModel.getOne(openid);
    if (!user) this.AppError('学生不存在', appCode.LOGIC);
    return user;
  }

  /** 修改学生信息 */
  async studentEdit(operator, { openid, name, student_no, phone, college }) {
    const user = await UserModel.getOne(openid);
    if (!user) this.AppError('学生不存在', appCode.LOGIC);
    await UserModel.edit(openid, {
      name: name,
      student_no: student_no,
      phone: phone,
      college: college,
      update_time: timeUtil.now(),
    });
    await this._log(operator, 'edit_student', openid, name || openid, { student_no: student_no });
    return { edited: true };
  }

  async _log(operator, action, targetOpenid, targetDesc, detail) {
    await OperationLogModel.insert({
      module: 'hr',
      action: action,
      operator_openid: operator._id,
      operator_name: operator.name || '',
      operator_role: operator.role,
      target_openid: targetOpenid,
      target_desc: targetDesc,
      detail: detail,
      create_time: timeUtil.now(),
    });
  }
}

module.exports = HrService;
