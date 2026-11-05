/**
 * captcha 业务逻辑：生成验证码 / 校验（一次性）/ 通用窗口限流
 * 防脚本核心：预约等写接口必须先通过人机校验（captcha），再叠加窗口冷却限流。
 */
const crypto = require('crypto');
const BaseService = require('./base_service.js');
const CaptchaModel = require('../model/captcha_model.js');
const AntiAbuseModel = require('../model/anti_abuse_model.js');
const config = require('../../config/config.js');
const timeUtil = require('../../framework/utils/time_util.js');
const appCode = require('../../framework/core/app_code.js');

class CaptchaService extends BaseService {
  /** 生成一条算术验证码（题目 + token），token 一次性、短有效期、绑定 openid */
  async issue(openid) {
    const now = timeUtil.now();
    const { question, answer } = genQuestion();
    const token = genToken();
    await CaptchaModel.insert({
      _id: token,
      openid: openid,
      question: question,
      answer: answer,
      expire_time: now + config.CAPTCHA_EXPIRE_MS,
      used: 0,
      use_time: 0,
      create_time: now,
    });
    return {
      token: token,
      question: question,
      expire_seconds: Math.floor(config.CAPTCHA_EXPIRE_MS / 1000),
    };
  }

  /**
   * 校验验证码（一次性消费）。
   * 校验顺序：存在性 -> 未过期 -> 未使用 -> openid 匹配 -> 答案匹配 -> 原子翻转 used。
   */
  async verify(openid, token, answer) {
    if (!token) this.AppError('请先完成人机验证', appCode.CAPTCHA_REQUIRED);
    if (answer === undefined || answer === null || String(answer).trim() === '') {
      this.AppError('请输入验证码答案', appCode.CAPTCHA_REQUIRED);
    }

    const now = timeUtil.now();
    const cap = await CaptchaModel.getOne(token);
    if (!cap || cap.used || cap.expire_time <= now) {
      this.AppError('验证码已失效，请刷新后重试', appCode.CAPTCHA_INVALID);
    }
    if (cap.openid !== openid) {
      this.AppError('验证码校验失败，请刷新后重试', appCode.CAPTCHA_INVALID);
    }
    if (String(cap.answer) !== String(answer).trim()) {
      this.AppError('验证码答案错误', appCode.CAPTCHA_WRONG);
    }

    // 一次性：仅当仍为「未使用」时原子翻转，防止并发复用同一 token
    const updated = await CaptchaModel.edit(
      { _id: token, used: 0 },
      { used: 1, use_time: now }
    );
    if (updated !== 1) {
      this.AppError('验证码已被使用，请刷新后重试', appCode.CAPTCHA_INVALID);
    }
    return true;
  }

  /**
   * 通用窗口限流：同一 openid 同一 route 在窗口内仅允许 1 次请求。
   * 用 anti_abuse 主键原子抢占（插入成功=放行 / 主键冲突=限流），多实例下可靠。
   * @returns true 放行；触发限流则抛 AppError(TOO_FREQUENT)
   */
  async checkRateLimit(openid, route) {
    const windowMs = config.RATE_LIMIT && config.RATE_LIMIT[route];
    if (!windowMs) return true; // 不在限流清单，放行

    const now = timeUtil.now();
    const lockId = AntiAbuseModel.key(openid, route, windowMs, now);
    const windowKey = Math.floor(now / windowMs);

    try {
      await AntiAbuseModel.insert({
        _id: lockId,
        openid: openid,
        route: route,
        window_key: windowKey,
        create_time: now,
      });
    } catch (e) {
      const m = String((e && (e.errMsg || e.message)) || '');
      if (m.indexOf('duplicate') >= 0 || m.indexOf('dup') >= 0 || m.indexOf('already exist') >= 0) {
        this.AppError('操作过于频繁，请稍后再试', appCode.TOO_FREQUENT);
      }
      throw e;
    }
    return true;
  }
}

/** 生成算术题：+ / - / ×，保证答案为非负整数，字符串答案避免数字类型差异 */
function genQuestion() {
  const rnd = (n) => Math.floor(Math.random() * n);
  const kind = rnd(3);
  let a, b, op, answer;
  if (kind === 0) {
    a = 1 + rnd(20);
    b = 1 + rnd(20);
    op = '+';
    answer = a + b;
  } else if (kind === 1) {
    a = 1 + rnd(20);
    b = 1 + rnd(a);
    op = '-';
    answer = a - b;
  } else {
    a = 2 + rnd(8);
    b = 2 + rnd(8);
    op = '×';
    answer = a * b;
  }
  return { question: a + ' ' + op + ' ' + b + ' = ?', answer: String(answer) };
}

/** 生成随机 token（crypto 强随机） */
function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = CaptchaService;
