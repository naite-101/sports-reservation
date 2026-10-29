/**
 * smoke 控制器（云端冒烟测试入口，受 job_secret 保护）
 */
const BaseController = require('./base_controller.js');
const SmokeService = require('../service/smoke_service.js');

class SmokeController extends BaseController {
  async run() {
    return await new SmokeService().run();
  }
}

module.exports = SmokeController;
