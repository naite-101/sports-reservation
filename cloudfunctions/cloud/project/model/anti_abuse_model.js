/**
 * anti_abuse 防刷限流表
 * 主键 `openid_route_windowKey` 天然唯一，通过「插入成功=放行 / 主键冲突=限流」实现
 * 固定窗口冷却（同一用户同一接口在窗口内仅 1 次），多实例下依然可靠（依赖数据库主键而非内存）。
 */
const BaseModel = require('./base_model.js');

class AntiAbuseModel extends BaseModel {}

AntiAbuseModel.CL = 'anti_abuse';

AntiAbuseModel.DB_STRUCTURE = {
  _id: 'string',
  openid: 'string',
  route: 'string',
  window_key: 'number',
  create_time: 'number',
};

/**
 * 拼装窗口限流锁主键
 * @param {string} openid 用户标识
 * @param {string} route 路由名（如 reservation/create）
 * @param {number} windowMs 窗口时长（毫秒）
 * @param {number} now 当前时间戳（毫秒）
 */
AntiAbuseModel.key = function (openid, route, windowMs, now) {
  return openid + '_' + route + '_' + Math.floor(now / windowMs);
};

module.exports = AntiAbuseModel;
