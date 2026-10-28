/**
 * 测试入口：加载全部 *.test.js 并运行，输出汇总，失败以非零码退出。
 * 运行：node test/run.js
 */
const fs = require('fs');
const path = require('path');
const lib = require('./_lib.js');
// 必须在加载任何业务模块前安装：把 require('wx-server-sdk') 指向内存 mock
require('./_mock_cloud.js').install();

(async function main() {
  const dir = __dirname;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .sort();

  for (const f of files) {
    console.log('\n=== ' + f + ' ===');
    require(path.join(dir, f));
  }

  console.log('\n==============================');
  const result = await lib.run();
  console.log('==============================');
  console.log('总计: ' + (result.passed + result.failed) +
    ' | 通过: ' + result.passed +
    ' | 失败: ' + result.failed);

  if (result.failed > 0) {
    console.log('\n失败明细：');
    for (const f of result.failures) {
      console.log('  - ' + f.name + '\n    ' + f.message);
    }
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✓');
  }
})();
