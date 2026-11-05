/**
 * 错误码定义（严格遵循 ARCHITECTURE §9.2）
 */
module.exports = {
  SUCC: 200, // 成功
  SVR: 500, // 服务器错误
  DATA: 1301, // 参数校验错误
  LOGIC: 1600, // 通用逻辑错误

  NO_LOGIN: 4001, // 未登录
  NO_RIGHT: 4003, // 无权限
  BLACKLIST: 4004, // 被拉黑（data 附剩余天数）
  NO_PROFILE: 4010, // 未完善个人信息

  VENUE_TAKEN: 4100, // 预约冲突：场地已被预约
  DUPLICATE_SLOT: 4101, // 重复预约：同一时间窗只能约一个场地
  NOT_OPEN_TIME: 4102, // 不在开放时间
  QR_EXPIRED: 4103, // 二维码过期需刷新
  NO_VALID_BOOKING: 4104, // 无对应有效预约
  SLOT_MISMATCH: 4105, // 预约场次不匹配
  VENUE_CLOSED: 4106, // 场地闭馆不可预约
  CANCEL_TOO_LATE: 4107, // 已过取消时间

  CAPTCHA_REQUIRED: 4200, // 未携带验证码（防脚本人机校验缺失）
  CAPTCHA_INVALID: 4201, // 验证码失效/过期/已使用/不匹配
  CAPTCHA_WRONG: 4202, // 验证码答案错误
  TOO_FREQUENT: 4203, // 操作过于频繁（触发限流/冷却）
};
