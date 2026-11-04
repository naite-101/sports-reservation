/**
 * student_slot_locks 学生时段锁表（★并发核心兜底）
 * _id = `${student_openid}_${date}_${slot_key}` 组合主键天然唯一，
 * 保证「同一学生同一时段只约 1 个场地」，不依赖控制台手动建唯一索引。
 * 生命周期：create 事务内加锁；cancel / 闭馆联动取消 / 爽约扫描 三条路径释放锁。
 */
const BaseModel = require('./base_model.js');

class StudentSlotLockModel extends BaseModel {}

StudentSlotLockModel.CL = 'student_slot_locks';

StudentSlotLockModel.DB_STRUCTURE = {
  _id: 'string',
  student_openid: 'string',
  date: 'string',
  slot_key: 'string',
  venue_key: 'string',
  res_id: 'string',
  create_time: 'number',
};

/** 拼装锁主键 */
StudentSlotLockModel.key = function (openid, date, slot_key) {
  return openid + '_' + date + '_' + slot_key;
};

module.exports = StudentSlotLockModel;
