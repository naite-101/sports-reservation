/**
 * notice_read 公告已读记录表
 */
const BaseModel = require('./base_model.js');

class NoticeReadModel extends BaseModel {}

NoticeReadModel.CL = 'notice_read';

NoticeReadModel.DB_STRUCTURE = {
  _id: 'string',
  openid: 'string',
  notice_id: 'string',
  read_time: 'number',
};

module.exports = NoticeReadModel;
