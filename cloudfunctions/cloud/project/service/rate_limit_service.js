/**
 * 防刷限流（纯服务端、无感）：不引入人机验证码，靠「窗口冷却」拦截脚本高频刷预约。
 *
 * 设计说明：
 *  - 微信小程序天然要求微信登录，openid 全局唯一，脚本想大规模刷需要海量微信号，成本极高；
 *  - 因此对「同一 openid 同一写接口」做窗口冷却即可有效防刷，且对真人完全无感（真人不会在
 *    3 秒内连续提交两次预约）。
 *  - 以 reservation/create 的 3000ms 窗口为例，等价于「同一人每分钟最多 20 次预约尝试」，
 *    已经构成频率上限，可拦住绝大多数抢单脚本；被拦时返回 4203，不影响正常抢场。
 *
 * 实现：用 anti_abuse 集合主键原子抢占（插入成功=放行 / 主键冲突=限流），多实例下可靠。
 */
const BaseService = require('./base_service.js');
const AntiAbuseModel = require('../model/anti_abuse_model.js');
const config = require('../../config/config.js');
const timeUtil = require('../../framework/utils/time_util.js');
const appCode = require('../../framework/core/app_code.js');

class RateLimitService extends BaseService {
  /**
   * 通用窗口限流：同一 openid 同一 route 在窗口内仅允许 1 次请求。
   * @param {string} openid 用户标识
   * @param {string} route  路由名（如 reservation/create）
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
        // 主键冲突：窗口内重复请求 → 触发限流
        this.AppError('操作过于频繁，请稍后再试', appCode.TOO_FREQUENT);
      }
      // 其它异常（如 anti_abuse 集合尚未创建、网络抖动等）：降级放行（fail-open），
      // 避免「限流存储异常」拖垮正常业务（预约还有锁表/主键唯一兜底，不会因此超约）。
      // 记一条日志便于排查；待 init/run 建好 anti_abuse 集合后，限流自动恢复生效。
      console.warn('[rate_limit] 限流检查异常，降级放行 route=' + route + ' err=' + m);
      return true;
    }
    return true;
  }
}

module.exports = RateLimitService;
