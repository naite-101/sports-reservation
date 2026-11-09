/**
 * checkin_companions 附属人员补录表（场地管理后台扫码补录，与签到记录 1:N）
 *
 * 设计说明（增量开发）：
 * - 扫码签到时的附属人员仍存放在 checkin_records.companions 内，原有结构不动；
 * - 管理员在场地管理页扫描附属人员的「个人二维码」后写入本表，checkin_id 指向 checkin_records._id；
 * - 列表合并两处数据，用 source 字段区分：'onsite'（签到现场随行）/ 'admin'（后台扫码补录）。
 */
const BaseModel = require('./base_model.js');

class CheckinCompanionModel extends BaseModel {}

CheckinCompanionModel.CL = 'checkin_companions';

// 字段结构（文档用途）
CheckinCompanionModel.DB_STRUCTURE = {
  _id: 'string',
  checkin_id: 'string', // checkin_records._id
  res_id: 'string',
  date: 'string',
  slot_key: 'string',
  venue_key: 'string',
  venue_type: 'string',
  venue_type_name: 'string',
  court_no: 'number',
  main_openid: 'string',
  main_name: 'string',
  main_student_no: 'string',
  companion_openid: 'string', // 被扫码的附属人员 openid（用于防重复）
  name: 'string',
  student_no: 'string',
  college: 'string',
  phone: 'string',
  remark: 'string',
  source: 'string', // admin
  add_method: 'string', // scan
  operator_openid: 'string',
  operator_name: 'string',
  add_time: 'number',
};

CheckinCompanionModel.SOURCE = { ONSITE: 'onsite', ADMIN: 'admin' };

module.exports = CheckinCompanionModel;
