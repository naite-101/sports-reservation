const application = require('./framework/core/application.js');

/**
 * 云函数统一入口。
 *
 * 支持两种触发方式，通过 event 结构自动区分：
 * 1. 小程序 callFunction 触发：event = { route, ...params }，直接交给 application.app 处理。
 * 2. HTTP 访问服务触发：event = { httpMethod, path, body, queryStringParameters, headers, ... }。
 *    此时把 body(JSON) 解析为 { route, ...params } 交给同一套 application.app，再把结果
 *    包装成 { statusCode, body } 返回给网关。
 *
 * 注意：HTTP 触发默认不带微信登录态（getWXContext().OPENID 为空），因此只能访问
 * 不需要 openid 的只读路由（如 notice/latest、config/get、venue/list 需要 role>=1 会 4003）。
 * 该入口仅用于「外部并发压测 / 第三方对接」，生产鉴权仍走小程序 callFunction。
 */
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
    } else if (event.body && typeof event.body === 'object') {
      params = event.body;
    }
    // 合并 queryString 参数（GET 请求可能用 query 传 route）
    if (event.queryStringParameters) {
      params = Object.assign({}, event.queryStringParameters, params);
    }
  } catch (e) {
    return httpResp(400, { code: 1301, msg: '请求体不是合法 JSON', data: {} });
  }

  // 复用统一入口逻辑
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
