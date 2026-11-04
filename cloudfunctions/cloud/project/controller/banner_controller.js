/**
 * banner 控制器：首页轮播图
 */
const BaseController = require('./base_controller.js');
const BannerService = require('../service/banner_service.js');
const appCode = require('../../framework/core/app_code.js');

class BannerController extends BaseController {
  async list() {
    return await new BannerService().list();
  }

  async add() {
    const input = this.validateData({ fileID: 'must|string|name=图片文件' });
    return await new BannerService().add(this._user, input.fileID);
  }

  async remove() {
    const input = this.validateData({ id: 'must|string|name=轮播图ID' });
    return await new BannerService().remove(this._user, input.id);
  }

  async sort() {
    const input = this.validateData({ ids: 'must|array|name=排序ID列表' });
    if (!input.ids || input.ids.length === 0) {
      this.AppError('「排序ID列表」不能为空', appCode.DATA);
    }
    return await new BannerService().sort(this._user, input.ids);
  }
}

module.exports = BannerController;
