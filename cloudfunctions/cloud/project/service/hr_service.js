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

  /** 任免/新增管理员（仅 2=普通管理员 / 3=超级管理员） */
  async adminAdd(operator, { openid, role, name }) {
    role = Number(role);
    if (role !== config.ROLE.ADMIN && role !== config.ROLE.SUPER_ADMIN) {
      this.AppError('仅可任免普通管理员或超级管理员', appCode.DATA);
    }
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
    if (role !== config.ROLE.ADMIN && role !== config.ROLE.SUPER_ADMIN) {
      this.AppError('权限等级不合法', appCode.DATA);
    }
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
