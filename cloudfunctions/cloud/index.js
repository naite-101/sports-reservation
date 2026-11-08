const application = require('./framework/core/application.js');

/**
 * 云函数统一入口。
 *
 * 支持两种触发方式，通过 event 结构自动区分：
 * 1. 小程序 callFunction 触发：event = { route, ...params }，直接交给 application.app 处理。
 * 2. HTTP 访问服务触发：event = { httpMethod, path, body, queryStringParameters, headers, ... }。
 *    此时把 body(JSON) 解析为 { route, ...params }，仅放行匿名只读白名单路由，
 *    再把结果包装成 { statusCode, body } 返回给网关。
 *
 * 安全说明（H-5 修复）：
 * - HTTP 触发不带微信登录态（getWXContext().OPENID 为空），无法鉴权。
 * - 因此 HTTP 通道**只允许**匿名只读路由（公告/配置/轮播图），写操作与
 *   init/run、smoke/run、job/* 一律拒绝（403），防止免登录触发写接口。
 * - 生产鉴权仍走小程序 callFunction；外部压测请使用测试环境。
 */

// HTTP 通道只读白名单（匿名可访问）
const HTTP_READONLY_ROUTES = ['notice/latest', 'notice/list', 'notice/detail', 'config/get', 'banner/list'];

exports.main = async (event, context) => {
  // 判定是否 HTTP 触发：腾讯云开发 HTTP 网关会注入 httpMethod 字段
  const isHttp = !!(event && (event.httpMethod !== undefined || event.headers !== undefined));

  if (!isHttp) {
    // 小程序 callFunction / 定时触发器，走原有逻辑
    return await application.app(event, context);
  }

  // ---- HTTP 触发分支 ----
  let params = {};
  try {
    // body 可能是字符串 JSON，也可能是已解析对象
    if (typeof event.body === 'string' && event.body.trim()) {
      params = JSON.parse(event.body);
    } else if (event.body && event.body === 'object') {
      params = event.body;
    }
    // 合并 queryString 参数（GET 请求可能用 query 传 route）
    if (event.queryStringParameters) {
      params = Object.assign({}, event.queryStringParameters, params);
    }
  } catch (e) {
    return httpResp(400, { code: 1301, msg: '请求体不是合法 JSON', data: {} });
  }

  // H-5：HTTP 通道只放行只读白名单，其余一律拒绝（含 init/run、smoke/run、job/* 与全部写接口）
  const route = String(params.route || '').toLowerCase().trim();
  if (HTTP_READONLY_ROUTES.indexOf(route) < 0) {
    return httpResp(403, { code: 4003, msg: 'HTTP 通道仅支持只读接口', data: {} });
  }

  // 复用统一入口逻辑（只读路由本身 role:0，无需登录态）
  let result;
  try {
    result = await application.app(params, context);
  } catch (e) {
    result = { code: 500, msg: '服务器繁忙，请稍后再试', data: {} };
  }

  const statusCode = result && result.code === 200 ? 200 : 200;
  return httpResp(statusCode, result);
};

/** 包装为 HTTP 网关要求的响应结构 */
function httpResp(statusCode, obj) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  };
}
