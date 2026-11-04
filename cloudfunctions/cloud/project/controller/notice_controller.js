/**
 * notice 控制器：公告查看 / 管理
 */
const BaseController = require('./base_controller.js');
const NoticeService = require('../service/notice_service.js');

class NoticeController extends BaseController {
  async latest() {
    return await new NoticeService().latest();
  }

  async list() {
    const input = this.validateData({
      page: 'int|default=1',
      size: 'int|default=20',
    });
    return await new NoticeService().list(input.page, input.size, this._openId);
  }

  async detail() {
    const input = this.validateData({ id: 'must|string|name=公告ID' });
    return await new NoticeService().detail(input.id);
  }

  async read() {
    const input = this.validateData({ notice_id: 'must|string|name=公告ID' });
    return await new NoticeService().read(this._openId, input.notice_id);
  }

  async adminList() {
    return await new NoticeService().adminList();
  }

  async add() {
    const input = this.validateData({
      title: 'must|string|min:1|max:100|name=标题',
      content: 'must|string|min:1|max:5000|name=内容',
    });
    return await new NoticeService().add(this._user, input);
  }

  async edit() {
    const input = this.validateData({
      id: 'must|string|name=公告ID',
      title: 'must|string|min:1|max:100|name=标题',
      content: 'must|string|min:1|max:5000|name=内容',
    });
    return await new NoticeService().edit(this._user, input.id, { title: input.title, content: input.content });
  }

  async remove() {
    const input = this.validateData({ id: 'must|string|name=公告ID' });
    return await new NoticeService().remove(this._user, input.id);
  }
}

module.exports = NoticeController;
