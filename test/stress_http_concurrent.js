/**
 * 外部真实并发压测脚本（针对云函数 HTTP 访问服务）
 *
 * 用途：从本机向「已部署到微信云端」的云函数发真实并发 HTTP 请求，
 *       测出云函数在真实并发下的表现：成功率 / 延迟 / 限流 / 超时 / 5xx。
 *
 * 重要前提（务必先做）：
 *   1. 云函数已重新上传部署（含 index.js 的 HTTP 兼容改动）。
 *   2. 在云开发控制台 → HTTP 访问服务（HTTP 网关）→ 路由管理，为 cloud 函数
 *      新建一条路由（如 /gym），关联资源类型选「云函数」。
 *   3. 把下面 BASE_URL 改成你环境实际生成的 URL。
 *
 * 说明：
 *   - HTTP 触发默认不带微信登录态（OPENID 为空），所以只能压「不需要 openid 的只读路由」，
 *     如 notice/latest、config/get。这测的是「云函数扛不扛得住并发」，不测业务抢场地。
 *   - 「200 人抢同一场地」需要 200 个真实 openid，只能靠真人/多微信号，HTTP 外部模拟不了。
 *
 * 运行：node test/stress_http_concurrent.js [并发数] [请求总数]
 */
const path = require('path');

// ============ 配置（按你的环境修改） ============
// 云开发 HTTP 访问服务生成的公网地址（环境 ID + 触发路径）
// 形如：https://<你的环境ID>.service.tcloudbase.com/gym
const BASE_URL = process.env.STRESS_URL || 'https://zd-tiyuguan-dev-d0f7ou1xabb04937.service.tcloudbase.com/gym';
// 压测的只读路由（不需要 openid）
const ROUTE = 'notice/latest';
// ================================================

const CONCURRENCY = Number(process.argv[2]) || 200; // 同时并发数
const TOTAL = Number(process.argv[3]) || 200; // 总请求数

async function oneRequest(i) {
  const t0 = Date.now();
  const res = {
    i,
    ok: false,
    status: 0,
    code: '',
    latency: 0,
    msg: '',
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000); // 单请求 15s 超时
    let resp;
    try {
      resp = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route: ROUTE }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    res.status = resp.status;
    res.latency = Date.now() - t0;

    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }

    if (resp.status === 200 && json && json.code === 200) {
      res.ok = true;
      res.code = '200';
    } else if (resp.status === 429) {
      res.code = '429-限流';
      res.msg = text.slice(0, 120);
    } else {
      res.code = String(resp.status);
      res.msg = (json && json.msg) ? json.msg : text.slice(0, 120);
    }
  } catch (e) {
    res.latency = Date.now() - t0;
    res.code = (e.name === 'AbortError') ? '超时' : ('异常-' + e.name);
    res.msg = String(e.message || e).slice(0, 120);
  }
  return res;
}

async function main() {
  console.log('==============================');
  console.log('外部真实并发压测（云函数 HTTP 访问）');
  console.log('==============================');
  console.log('目标 URL     = ' + BASE_URL);
  console.log('压测路由     = ' + ROUTE);
  console.log('并发数       = ' + CONCURRENCY);
  console.log('总请求数     = ' + TOTAL);
  console.log('');

  const all = [];
  let cursor = 0;
  const t0 = Date.now();

  // 分批并发：每次发 CONCURRENCY 个，直到发满 TOTAL
  while (cursor < TOTAL) {
    const batch = Math.min(CONCURRENCY, TOTAL - cursor);
    const batchResults = await Promise.all(
      Array.from({ length: batch }, (_, k) => oneRequest(cursor + k))
    );
    all.push(...batchResults);
    cursor += batch;
  }

  const elapsed = Date.now() - t0;

  // 统计
  const ok = all.filter((r) => r.ok);
  const fail = all.filter((r) => !r.ok);
  const byCode = {};
  for (const r of all) {
    byCode[r.code] = (byCode[r.code] || 0) + 1;
  }
  const lat = all.map((r) => r.latency).sort((a, b) => a - b);
  const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : 0;

  console.log('------------------------------');
  console.log('结果汇总');
  console.log('------------------------------');
  console.log('总请求数       = ' + all.length);
  console.log('成功(200)      = ' + ok.length);
  console.log('失败           = ' + fail.length);
  console.log('成功率         = ' + (all.length ? (ok.length / all.length * 100).toFixed(1) : 0) + '%');
  console.log('总耗时         = ' + elapsed + ' ms');
  console.log('吞吐           = ' + (all.length / (elapsed / 1000)).toFixed(1) + ' 请求/秒');
  console.log('延迟 最小/中位/95%/最大 = ' + pct(0) + ' / ' + pct(0.5) + ' / ' + pct(0.95) + ' / ' + pct(0.99) + ' ms');
  console.log('');
  console.log('状态分布：');
  for (const k of Object.keys(byCode).sort()) {
    console.log('  ' + k + ' : ' + byCode[k]);
  }

  if (fail.length) {
    console.log('');
    console.log('失败样本（前 8 条）：');
    fail.slice(0, 8).forEach((r) => {
      console.log('  #' + r.i + ' ' + r.code + ' ' + r.msg);
    });
  }

  console.log('');
  console.log('==============================');
  if (ok.length === all.length) {
    console.log('结论：全部成功，云函数在 ' + CONCURRENCY + ' 并发下未崩、未限流 ✓');
  } else if (ok.length > 0) {
    console.log('结论：部分失败（成功率 ' + (ok.length / all.length * 100).toFixed(1) + '%）。');
    console.log('      若出现 429/超时/5xx，说明云函数在 ' + CONCURRENCY + ' 并发下被限流或扛不住，');
    console.log('      需关注：函数超时配置(当前60s)、并发实例数、数据库连接数。');
  } else {
    console.log('结论：全部失败。请先确认 HTTP 路由已配置、URL 正确、云函数已部署。');
  }
  console.log('==============================');
}

main().catch((e) => {
  console.error('压测脚本自身出错：', e);
  process.exit(2);
});
