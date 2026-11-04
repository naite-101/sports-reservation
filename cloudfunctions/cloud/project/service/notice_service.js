/**
 * notice 业务逻辑：公告查看/管理
 */
const BaseService = require('./base_service.js');
const NoticeModel = require('../model/notice_model.js');
const NoticeReadModel = require('../model/notice_read_model.js');
const OperationLogModel = require('../model/operation_log_model.js');
const timeUtil = require('../../framework/utils/time_util.js');
const appCode = require('../../framework/core/app_code.js');
const dbUtil = require('../../framework/database/db_util.js');

class NoticeService extends BaseService {
  /** 最新一条已发布公告 */
  async latest() {
    return await NoticeModel.getOne({ status: 'published' }, '*', { publish_time: 'desc' });
  }

  /** 公告列表（已发布）；openId 非空时附带每条 is_read（已读状态） */
  async list(page = 1, size = 20, openId = '') {
    const res = await NoticeModel.getList({ status: 'published' }, '*', { publish_time: 'desc' }, page, size);
    const list = res.list || [];
    if (openId && list.length > 0) {
      await this._ensureReadCollection();
      const ids = list.map((n) => n._id);
      const reads = await NoticeReadModel.getAll({ openid: openId, notice_id: ['in', ids] }, 'notice_id');
      const readSet = new Set((reads || []).map((r) => r.notice_id));
      res.list = list.map((n) => Object.assign({}, n, { is_read: readSet.has(n._id) }));
    } else {
      res.list = list.map((n) => Object.assign({}, n, { is_read: false }));
    }
    return res;
  }

  /** 公告详情 */
  async detail(id) {
    const n = await NoticeModel.getOne(id);
    if (!n || n.status === 'deleted') this.AppError('公告不存在或已删除', appCode.LOGIC);
    return n;
  }

  /** 标记公告已读（幂等：重复标记静默成功；并发下依靠 duplicate 兜底） */
  async read(openId, noticeId) {
    if (!openId) this.AppError('请先登录', appCode.NO_LOGIN);

    // 校验公告存在且处于已发布状态
    const n = await NoticeModel.getOne(noticeId);
    if (!n || n.status !== 'published') this.AppError('公告不存在或已删除', appCode.LOGIC);

    // 已读则直接返回，避免重复插入（先确保集合存在，防止首次调用因集合未建而报错）
    await this._ensureReadCollection();
    const exist = await NoticeReadModel.getOne({ openid: openId, notice_id: noticeId });
    if (exist) return { read: true };

    try {
      await NoticeReadModel.insert({ openid: openId, notice_id: noticeId, read_time: timeUtil.now() });
    } catch (e) {
      const msg = String((e && (e.errMsg || e.message)) || '');
      // 并发场景唯一索引拦截的 duplicate 视为已读成功；其余异常继续抛出
      if (!/duplicate/i.test(msg)) throw e;
    }
    return { read: true };
  }

  /** 确保 notice_read 集合存在（懒建兜底：未跑 init/run 时也能正常记录已读） */
  async _ensureReadCollection() {
    if (this._readCollectionEnsured) return;
    try {
      const exist = await dbUtil.isExistCollection(NoticeReadModel.CL);
      if (!exist) {
        await dbUtil.createCollection(NoticeReadModel.CL);
      }
    } catch (e) {
      // 建集合失败不阻断主流程（可能因并发已存在）
    }
    this._readCollectionEnsured = true;
  }

  /** 管理端公告列表（含已删除） */
  async adminList() {
    return await NoticeModel.getAll({}, '*', { publish_time: 'desc' });
  }

  /** 发布公告 */
  async add(operator, { title, content }) {
    const now = timeUtil.now();
    await NoticeModel.insert({
      title: title,
      content: content,
      status: 'published',
      author_openid: operator._id,
      author_name: operator.name || '',
      publish_time: now,
      update_time: now,
    });
    return { added: true };
  }

  /** 修改公告 */
  async edit(operator, id, { title, content }) {
    const n = await NoticeModel.getOne(id);
    if (!n) this.AppError('公告不存在', appCode.LOGIC);
    const now = timeUtil.now();
    await NoticeModel.edit(id, { title: title, content: content, update_time: now });
    await OperationLogModel.insert({
      module: 'notice',
      action: 'edit_notice',
      operator_openid: operator._id,
      operator_name: operator.name || '',
      operator_role: operator.role,
      target_desc: id,
      detail: { title: title },
      create_time: now,
    });
    return { edited: true };
  }

  /** 删除公告（逻辑删除） */
  async remove(operator, id) {
    const n = await NoticeModel.getOne(id);
    if (!n) this.AppError('公告不存在', appCode.LOGIC);
    const now = timeUtil.now();
    await NoticeModel.edit(id, { status: 'deleted', update_time: now });
    await OperationLogModel.insert({
      module: 'notice',
      action: 'delete_notice',
      operator_openid: operator._id,
      operator_name: operator.name || '',
      operator_role: operator.role,
      target_desc: id,
      detail: { title: n.title || '' },
      create_time: now,
    });
    return { removed: true };
  }
}

module.exports = NoticeService;
