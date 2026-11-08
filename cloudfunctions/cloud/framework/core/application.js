/**
 * 云函数统一入口主逻辑：路由分发 + 鉴权中间件 + 异常处理 + 统一返回
 */
const appUtil = require('./app_util.js');
const appCode = require('./app_code.js');
const AppError = require('./app_error.js');
const config = require('../../config/config.js');
const routes = require('../../config/route.js');
const dbUtil = require('../database/db_util.js');
const UserModel = require('../../project/model/user_model.js');
const timeUtil = require('../utils/time_util.js');

// 天毫秒常量统一走 config.DAY_MS（L-7）

async function app(event, context) {
  event = event || {};

  // 定时触发器：仅认腾讯云定时触发器注入的 Type==='Timer'（M-2 修复：
  // 删除 triggerType / TriggerName 宽松分支，防止 callFunction 伪造触发字段绕过 job_secret）
  if (event.Type === 'Timer') {
    return await runTimerJob(event);
  }

  let route = '';
  try {
    route = String(event.route || '').toLowerCase().trim();
    if (!route) {
      return appUtil.handlerAppErr('缺少路由参数 route', appCode.DATA);
    }
    if (!route.includes('/')) {
      return appUtil.handlerAppErr('路由格式错误', appCode.DATA);
    }

    // 初始化脚本（密钥保护，仅部署时手动调用）
    if (route === 'init/run') {
      if (!config.JOB_SECRET || event.job_secret !== config.JOB_SECRET) {
        throw new AppError('无权限', appCode.NO_RIGHT);
      }
      const initData = require('../../project/init/init_data.js');
      const result = await initData.initAll();
      return appUtil.handlerData(result);
    }

    // 云端冒烟测试（密钥保护 + 环境开关，仅部署/排查时手动调用；H-5 修复：默认关闭）
    if (route === 'smoke/run') {
      if (process.env.ENABLE_SMOKE !== '1') {
        throw new AppError('无权限', appCode.NO_RIGHT);
      }
      if (!config.JOB_SECRET || event.job_secret !== config.JOB_SECRET) {
        throw new AppError('无权限', appCode.NO_RIGHT);
      }
      const SmokeService = require('../../project/service/smoke_service.js');
      const result = await new SmokeService().run();
      return appUtil.handlerData(result);
    }

    const routeDef = routes[route];
    if (!routeDef) {
      return appUtil.handlerAppErr('路由不存在：' + route, appCode.DATA);
    }

    // 获取 openid（唯一可信来源）
    let openId = '';
    try {
      const wxContext = dbUtil.getCloud().getWXContext();
      openId = wxContext.OPENID || '';
    } catch (e) {
      openId = '';
    }

    const isJobRoute = route.indexOf('job/') === 0;

    // job 手动调用需密钥；定时器已在入口处理
    if (isJobRoute && (!config.JOB_SECRET || event.job_secret !== config.JOB_SECRET)) {
      throw new AppError('无权限', appCode.NO_RIGHT);
    }

    // 加载用户并计算有效角色
    let user = null;
    let role = 0;
    if (openId) {
      user = await UserModel.getOne(openId);
      if (user) {
        role = user.status === 0 ? 0 : (user.role || 0);
      }
    }

    // 角色校验
    if (!isJobRoute) {
      if (role < routeDef.role) {
        throw new AppError('无权限', appCode.NO_RIGHT);
      }
      // 黑名单拦截（预约/二维码类）
      if (user && user.black_until && user.black_until > timeUtil.now() && isBlockedRoute(route)) {
        const days = Math.ceil((user.black_until - timeUtil.now()) / config.DAY_MS);
        throw new AppError('您已被限制预约，' + days + ' 天内不可预约场馆', appCode.BLACKLIST, { black_days: days });
      }
    }

    // 通用写接口限流（防脚本高频刷）：鉴权通过后、执行前，按 RATE_LIMIT 配置做窗口冷却
    if (!isJobRoute && openId && config.RATE_LIMIT && config.RATE_LIMIT[route]) {
      const RateLimitService = require('../../project/service/rate_limit_service.js');
      await new RateLimitService().checkRateLimit(openId, route);
    }

    // 实例化 controller 并调用 action
    const ControllerClass = require('../../project/controller/' + routeDef.controller + '.js');
    const controller = new ControllerClass(route, openId, user, role, event);
    let result = await controller[routeDef.action]();

    if (result === undefined || result === null) result = {};
    return appUtil.handlerData(result);
  } catch (ex) {
    console.error('[gymreserve] route=' + route + ' error=', ex);
    if (ex && ex.name === 'AppError') {
      return appUtil.handlerAppErr(ex.message, ex.code, ex.data);
    }
    return appUtil.handlerSvrErr();
  }
}

/** 定时触发器分发 */
async function runTimerJob(event) {
  const name = String(event.TriggerName || event.triggerName || '');
  let action = '';
  if (name.indexOf('expire') >= 0) action = 'expire';
  else if (name.indexOf('notify') >= 0) action = 'notify';
  else return appUtil.handlerAppErr('未知定时任务：' + name, appCode.DATA);

  try {
    const JobController = require('../../project/controller/job_controller.js');
    const ctrl = new JobController('job/' + action, 'system', null, 0, {});
    const result = await ctrl[action]();
    return appUtil.handlerData(result || {});
  } catch (ex) {
    console.error('[gymreserve] job=' + action + ' error=', ex);
    if (ex && ex.name === 'AppError') {
      return appUtil.handlerAppErr(ex.message, ex.code, ex.data);
    }
    return appUtil.handlerSvrErr();
  }
}

/** 被拉黑时直接拒绝的路由 */
function isBlockedRoute(route) {
  return ['reservation/create', 'reservation/status', 'qrcode/generate', 'qrcode/valid_booking'].indexOf(route) >= 0;
}

module.exports = {
  app,
};
