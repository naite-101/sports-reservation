/**
 * captcha 控制器：验证码下发（防脚本人机校验）
 */
const BaseController = require('./base_controller.js');
const CaptchaService = require('../service/captcha_service.js');

class CaptchaController extends BaseController {
  /** 生成验证码（算术题 + token），预约前调用 */
  async issue() {
    return await new CaptchaService().issue(this._openId);
  }
}

module.exports = CaptchaController;
