/**
 * blacklist 控制器
 */
const BaseController = require('./base_controller.js');
const BlacklistService = require('../service/blacklist_service.js');
const appCode = require('../../framework/core/app_code.js');

class BlacklistController extends BaseController {
  async list() {
    return await new BlacklistService().list();
  }

  async add() {
    const input = this.validateData({
      student_openid: 'string|default=',
      student_no: 'string|default=',
      name: 'string|default=',
      duration_days: 'must|int|name=拉黑天数',
      reason: 'string|default=',
    });
    if (!input.student_openid && !input.student_no && !input.name) {
      this.AppError('「学号或姓名或openid」不能为空', appCode.DATA);
    }
    return await new BlacklistService().add(this._user, input);
  }

  async release() {
    const input = this.validateData({
      blacklist_id: 'must|string|name=黑名单ID',
      reason: 'string|default=',
    });
    return await new BlacklistService().release(this._user, input);
  }
}

module.exports = BlacklistController;
