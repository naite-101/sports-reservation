/**
 * banner 业务逻辑：首页轮播图管理
 */
const BaseService = require('./base_service.js');
const BannerModel = require('../model/banner_model.js');
const OperationLogModel = require('../model/operation_log_model.js');
const timeUtil = require('../../framework/utils/time_util.js');
const appCode = require('../../framework/core/app_code.js');

class BannerService extends BaseService {
  /** 轮播图列表（按 sort 升序） */
  async list() {
    return await BannerModel.getAll({}, '*', { sort: 'asc' });
  }

  /** 新增轮播图：sort = 当前最大 sort + 1（无则 0） */
  async add(operator, fileID) {
    const tops = await BannerModel.getAll({}, 'sort', { sort: 'desc' }, 1);
    const maxSort = tops && tops.length > 0 ? Number(tops[0].sort) || 0 : 0;
    const sort = maxSort + 1;
    const now = timeUtil.now();
    const id = await BannerModel.insert({
      fileID: fileID,
      sort: sort,
      create_time: now,
      update_time: now,
    });
    await OperationLogModel.insert({
      module: 'config',
      action: 'banner_add',
      operator_openid: operator._id,
      operator_name: operator.name || '',
      operator_role: operator.role,
      target_desc: id,
      detail: { fileID: fileID, sort: sort },
      create_time: now,
    });
    return { _id: id, fileID: fileID, sort: sort, create_time: now, update_time: now };
  }

  /** 删除轮播图 */
  async remove(operator, id) {
    const banner = await BannerModel.getOne(id);
    if (!banner) this.AppError('轮播图不存在', appCode.LOGIC);
    await BannerModel.del(id);
    await OperationLogModel.insert({
      module: 'config',
      action: 'banner_delete',
      operator_openid: operator._id,
      operator_name: operator.name || '',
      operator_role: operator.role,
      target_desc: id,
      detail: { fileID: banner.fileID || '' },
      create_time: timeUtil.now(),
    });
    return { removed: true };
  }

  /** 按 ids 顺序重排 sort */
  async sort(operator, ids) {
    for (let i = 0; i < ids.length; i++) {
      await BannerModel.edit(ids[i], { sort: i, update_time: timeUtil.now() });
    }
    await OperationLogModel.insert({
      module: 'config',
      action: 'banner_sort',
      operator_openid: operator._id,
      operator_name: operator.name || '',
      operator_role: operator.role,
      target_desc: ids.join(','),
      detail: { ids: ids },
      create_time: timeUtil.now(),
    });
    return { sorted: true };
  }
}

module.exports = BannerService;
