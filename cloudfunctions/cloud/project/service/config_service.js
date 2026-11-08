/**
 * config 业务逻辑：公开配置 / 修改配置 / 活动图片
 */
const BaseService = require('./base_service.js');
const ConfigModel = require('../model/config_model.js');
const TimeSlotModel = require('../model/time_slot_model.js');
const OperationLogModel = require('../model/operation_log_model.js');
const config = require('../../config/config.js');
const timeUtil = require('../../framework/utils/time_util.js');
const appCode = require('../../framework/core/app_code.js');

class ConfigService extends BaseService {
  /** 获取公开配置 */
  async get() {
    const result = {};
    const keys = ['open_time', 'activity_pic', 'subscribe_tpl'];
    for (const k of keys) {
      const cfg = await ConfigModel.getOne(k);
      result[k] = cfg ? cfg.value : (k === 'open_time' ? config.DEFAULT_OPEN_TIME : '');
    }
    const slots = await TimeSlotModel.getAll({}, '*', { sort: 'asc' });
    result.slots = slots;
    return result;
  }

  /** 修改基础配置（P2，当前支持 open_time） */
  async set(operator, { key, value }) {
    if (key !== 'open_time') this.AppError('暂不支持该配置项', appCode.DATA);
    // L-5：hour/minute 边界校验（hour ∈ [0,23]、minute ∈ [0,59]）
    const hour = Number(value && value.hour);
    const minute = Number(value && value.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      this.AppError('开放时间小时必须在 0~23 之间', appCode.DATA);
    }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      this.AppError('开放时间分钟必须在 0~59 之间', appCode.DATA);
    }
    const newValue = { hour: hour, minute: minute };
    await ConfigModel.insertOrUpdate(key, { key: key, value: newValue, update_time: timeUtil.now() });
    await OperationLogModel.insert({
      module: 'config',
      action: 'set_config',
      operator_openid: operator._id,
      operator_name: operator.name || '',
      operator_role: operator.role,
      target_desc: key,
      detail: { value: newValue },
      create_time: timeUtil.now(),
    });
    return { set: true };
  }

  /** 更换活动图片（存云存储 fileID） */
  async activityPic(operator, fileID) {
    await ConfigModel.insertOrUpdate('activity_pic', {
      key: 'activity_pic',
      value: fileID,
      update_time: timeUtil.now(),
    });
    await OperationLogModel.insert({
      module: 'config',
      action: 'activity_pic',
      operator_openid: operator._id,
      operator_name: operator.name || '',
      operator_role: operator.role,
      target_desc: 'activity_pic',
      detail: { fileID: fileID },
      create_time: timeUtil.now(),
    });
    return { fileID: fileID };
  }
}

module.exports = ConfigService;
