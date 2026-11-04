/**
 * hr 业务逻辑：人事管理（人事管理员）
 */
const BaseService = require('./base_service.js');
const UserModel = require('../model/user_model.js');
const OperationLogModel = require('../model/operation_log_model.js');
const config = require('../../config/config.js');
const timeUtil = require('../../framework/utils/time_util.js');
const appCode = require('../../framework/core/app_code.js');

class HrService extends BaseService {
  /**
   * 管理员列表：按操作者权限裁剪可见范围
   * - 超级管理员(3)：只能查看/管理普通管理员(2)
   * - 人事管理员(4)：可查看全部管理员(2/3/4)
   */
  async adminList(operator) {
    const operatorRole = Number(operator && operator.role);
    if (operatorRole === config.ROLE.SUPER_ADMIN) {
      return await UserModel.getAll({ role: config.ROLE.ADMIN }, '*', { role: 'desc', create_time: 'asc' });
    }
    if (operatorRole === config.ROLE.HR_ADMIN) {
      return await UserModel.getAll({ role: ['>=', config.ROLE.ADMIN] }, '*', { role: 'desc', create_time: 'asc' });
    }
    this.AppError('无权限查看管理员列表', appCode.NO_RIGHT);
  }

  /**
   * 任命权限规则：
   * - 超级管理员(3)：只能任命普通管理员(2)
   * - 人事管理员(4)：可任命普通管理员(2)、超级管理员(3)、人事管理员(4)
   * - 其他角色：无任命权
   * @returns 可任命的目标角色数组；空数组表示无权任命
   */
  assignableRoles(operatorRole) {
    operatorRole = Number(operatorRole);
    if (operatorRole === config.ROLE.SUPER_ADMIN) {
      return [config.ROLE.ADMIN];
    }
    if (operatorRole === config.ROLE.HR_ADMIN) {
      return [config.ROLE.ADMIN, config.ROLE.SUPER_ADMIN, config.ROLE.HR_ADMIN];
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

  /** 任免/新增管理员（支持 openid，或 keyword=学号/姓名 定位已注册用户） */
  async adminAdd(operator, { openid, keyword, role, name }) {
    role = Number(role);
    // 目标角色必须是合法管理员角色（2/3/4）
    if ([config.ROLE.ADMIN, config.ROLE.SUPER_ADMIN, config.ROLE.HR_ADMIN].indexOf(role) < 0) {
      this.AppError('仅可任命普通管理员、超级管理员或人事管理员', appCode.DATA);
    }
    // 按操作者权限校验（超管仅能任命普通管理员；人事管理员可任命到人事管理员）
    this.assertCanAssign(operator, role);

    // 定位目标用户：优先 openid；未提供 openid 时按学号/姓名解析
    let targetOpenid = openid || '';
    if (!targetOpenid && keyword) {
      targetOpenid = await this.resolveAdminTarget(keyword);
      if (!targetOpenid) {
        this.AppError('未找到该学号或姓名的用户，请确认对方已注册并使用过小程序', appCode.LOGIC);
      }
    }
    if (!targetOpenid) {
      this.AppError('请输入学号、姓名或 openid', appCode.DATA);
    }

    const now = timeUtil.now();
    const user = await UserModel.getOne(targetOpenid);
    if (!user) {
      await UserModel.insert({
        _id: targetOpenid,
        openid: targetOpenid,
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
      await UserModel.edit(targetOpenid, { role: role, name: name || user.name, status: 1, update_time: now });
    }
    await this._log(operator, 'assign_admin', targetOpenid, name || targetOpenid, { role: role });
    return { assigned: true };
  }

  /**
   * 按「学号 -> 姓名」定位目标用户 openid（姓名重复时报错，需改用学号）。
   * 找不到返回空字符串，由调用方决定后续处理。
   */
  async resolveAdminTarget(keyword) {
    const kw = String(keyword).trim();
    if (!kw) return '';
    const byNo = await UserModel.getOne({ student_no: kw });
    if (byNo) return byNo._id;
    const byName = await UserModel.getAll({ name: kw });
    if (byName.length > 1) {
      this.AppError('姓名重复，请改用学号', appCode.DATA);
    }
    if (byName.length === 1) return byName[0]._id;
    return '';
  }

  /** 移除管理员（降级为学生） */
  async adminRemove(operator, { openid }) {
    const user = await UserModel.getOne(openid);
    if (!user) this.AppError('用户不存在', appCode.LOGIC);
    // 只能操作权限低于自己的成员，否则人事管理员可直接把同级人事管理员降为学生
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
    if ([config.ROLE.ADMIN, config.ROLE.SUPER_ADMIN, config.ROLE.HR_ADMIN].indexOf(role) < 0) {
      this.AppError('权限等级不合法', appCode.DATA);
    }
    // 按操作者权限校验（与 adminAdd 一致）
    this.assertCanAssign(operator, role);
    const user = await UserModel.getOne(openid);
    if (!user) this.AppError('用户不存在', appCode.LOGIC);

    const data = { role: role, update_time: timeUtil.now() };
    if (status === 0 || status === 1) data.status = status;
    await UserModel.edit(openid, data);
    await this._log(operator, 'assign_admin', openid, user.name || openid, { role: role, status: data.status });
    return { assigned: true };
  }

  /**
   * 成员名单（学生 + 普通管理员）：供超管/人事管理员搜索并编辑个人信息
   * - 只返回学生(1)和普通管理员(2)，不含超管(3)/人事管理员(4)
   */
  async studentList({ keyword, page = 1, size = 20 }) {
    let where = { role: ['in', [config.ROLE.STUDENT, config.ROLE.ADMIN]] };
    if (keyword) {
      where = {
        role: ['in', [config.ROLE.STUDENT, config.ROLE.ADMIN]],
        or: [{ name: ['like', keyword] }, { student_no: ['like', keyword] }],
      };
    }
    return await UserModel.getList(where, '*', { create_time: 'desc' }, page, size);
  }

  /** 成员详情（学生或普通管理员） */
  async studentDetail(openid) {
    const user = await UserModel.getOne(openid);
    if (!user) this.AppError('用户不存在', appCode.LOGIC);
    return user;
  }

  /**
   * 修改成员个人信息（学生 / 普通管理员）
   * 权限规则：
   * - 超管(3)：可改学生(1)和普通管理员(2)，不能改超管(3)/人事管理员(4)
   * - 人事管理员(4)：可改学生(1)/普通管理员(2)/超管(3)，不能改同级人事管理员(4)
   */
  async studentEdit(operator, { openid, name, student_no, phone, college }) {
    const user = await UserModel.getOne(openid);
    if (!user) this.AppError('用户不存在', appCode.LOGIC);

    const targetRole = Number(user.role);
    const operatorRole = Number(operator && operator.role);
    // 只允许修改学生(1)或普通管理员(2)；超管/人事管理员的信息不在本入口修改
    if (targetRole >= config.ROLE.SUPER_ADMIN) {
      this.AppError('仅可修改学生或普通管理员的信息', appCode.NO_RIGHT);
    }
    // 目标角色必须低于操作者（超管可改普通管理员，人事管理员可改普通管理员/超管）
    if (targetRole >= operatorRole) {
      this.AppError('不能修改同级或更高权限成员的信息', appCode.NO_RIGHT);
    }

    await UserModel.edit(openid, {
      name: name,
      student_no: student_no,
      phone: phone,
      college: college,
      update_time: timeUtil.now(),
    });
    await this._log(operator, 'edit_member', openid, name || openid, { student_no: student_no });
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
