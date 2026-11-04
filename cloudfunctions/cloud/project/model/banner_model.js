/**
 * banners 首页轮播图表
 */
const BaseModel = require('./base_model.js');

class BannerModel extends BaseModel {}

BannerModel.CL = 'banners';

BannerModel.DB_STRUCTURE = {
  _id: 'string',
  fileID: 'string',
  sort: 'number',
  create_time: 'number',
  update_time: 'number',
};

module.exports = BannerModel;
