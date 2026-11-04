/**
 * passport 业务逻辑：登录/完善信息
 */
const BaseService = require('./base_service.js');
const UserModel = require('../model/user_model.js');
const config = require('../../config/config.js');
const timeUtil = require('../../framework/utils/time_util.js');
const appCode = require('../../framework/core/app_code.js');

class PassportService extends BaseService {
  /**
   * 登录：不存在则自动注册为学生（role=1）
   */
  async login(openId) {
    let user = await UserModel.getOne(openId);
    if (!user) {
      const now = timeUtil.now();
      await UserModel.insert({
        _id: openId,
        openid: openId,
        role: config.ROLE.STUDENT,
        name: '',
        student_no: '',
        phone: '',
        college: '',
        info_completed: false,
        status: 1,
        black_until: 0,
        create_time: now,
        update_time: now,
      });
      user = await UserModel.getOne(openId);
    }

    const blackUntil = user.black_until || 0;
    const blackDays = blackUntil > timeUtil.now() ? Math.ceil((blackUntil - timeUtil.now()) / 86400000) : 0;
    const role = user.status === 0 ? config.ROLE.ANONYMOUS : (user.role || 0);

    return {
      openid: openId,
      role: role,
      role_name: config.ROLE_LEVEL[role] || '未知',
      name: user.name || '',
      info_completed: !!user.info_completed,
      status: user.status,
      black_until: blackUntil,
      black_days: blackDays,
    };
  }

  /**
   * 完善个人信息
   */
  async saveProfile(openId, { name, student_no, phone, college }) {
    const now = timeUtil.now();
    const user = await UserModel.getOne(openId);

    // 权限控制：个人信息首次填写后可锁定
    // - 首次填写（无记录或 info_completed 为 false）：任何人可填写
    // - 已填写过：仅超级管理员(3)、人事管理员(4)可修改自己/他人信息
    //   普通学生(1)、普通管理员(2) 不能再修改
    if (user && user.info_completed) {
      const role = Number(user.role);
      if (role < config.ROLE.SUPER_ADMIN) {
        this.AppError('个人信息已锁定，如需修改请联系管理员', appCode.NO_RIGHT);
      }
    }

    const data = {
      name: name,
      student_no: student_no,
      phone: phone,
      college: college,
      info_completed: true,
      update_time: now,
    };
    if (!user) {
      await UserModel.insert({
        _id: openId,
        openid: openId,
        role: config.ROLE.STUDENT,
        status: 1,
        black_until: 0,
        create_time: now,
        ...data,
      });
    } else {
      await UserModel.edit(openId, data);
    }
    return { saved: true };
  }
}

module.exports = PassportService;
