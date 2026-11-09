/**
 * passport 控制器
 */
const BaseController = require('./base_controller.js');
const PassportService = require('../service/passport_service.js');

class PassportController extends BaseController {
  /** 登录 */
  async login() {
    const service = new PassportService();
    return await service.login(this._openId);
  }

  /** 完善个人信息 */
  async saveProfile() {
    const input = this.validateData({
      name: 'must|string|min:1|max:20|name=姓名',
      student_no: 'must|string|min:1|max:30|name=学号',
      phone: 'must|mobile|name=手机号',
      college: 'must|string|min:1|max:50|name=年级班级',
    });
    const service = new PassportService();
    return await service.saveProfile(this._openId, input);
  }
}

module.exports = PassportController;
