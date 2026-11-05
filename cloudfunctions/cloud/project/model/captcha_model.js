/**
 * captchas 验证码表（★防脚本人机校验）
 * _id = token（随机串），一次性使用、短有效期、绑定 openid。
 * 预约前必须先通过 captcha/issue 获取题目并答对，预约接口校验通过后才放行。
 */
const BaseModel = require('./base_model.js');

class CaptchaModel extends BaseModel {}

CaptchaModel.CL = 'captchas';

CaptchaModel.DB_STRUCTURE = {
  _id: 'string',
  openid: 'string',
  question: 'string',
  answer: 'string',
  expire_time: 'number',
  used: 'number',
  use_time: 'number',
  create_time: 'number',
};

module.exports = CaptchaModel;
