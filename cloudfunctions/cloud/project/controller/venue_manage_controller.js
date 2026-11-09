/**
 * 场地管理（管理后台）控制器：后台签到 / 签到人员 / 附属人员补录 / 拉黑
 */
const BaseController = require('./base_controller.js');
const VenueManageService = require('../service/venue_manage_service.js');

class VenueManageController extends BaseController {
  /** 签到人员列表（主签到人 + 附属人员） */
  async checkinList() {
    const input = this.validateData({
      date: 'date|default=',
      venue_type: 'string|default=',
      slot_key: 'string|default=',
      keyword: 'string|max:30|default=',
    });
    return await new VenueManageService().checkinList(input);
  }

  /** 当日待签到预约（后台签到的候选列表） */
  async pendingList() {
    const input = this.validateData({
      date: 'date|default=',
      venue_type: 'string|default=',
      slot_key: 'string|default=',
      keyword: 'string|max:30|default=',
    });
    return await new VenueManageService().pendingList(input);
  }

  /** 后台签到 */
  async checkin() {
    const input = this.validateData({
      res_id: 'must|string|name=预约ID',
      slot_key: 'string|default=',
    });
    return await new VenueManageService().checkin(this._user, input);
  }

  /** 附属人员扫码补录（扫描对方的个人二维码，无需手输） */
  async companionScan() {
    const input = this.validateData({
      checkin_id: 'must|string|name=签到记录ID',
      token: 'must|string|name=二维码内容',
    });
    return await new VenueManageService().companionScan(this._user, input);
  }

  /** 删除后台补录的附属人员 */
  async companionRemove() {
    const input = this.validateData({
      companion_id: 'must|string|name=补录记录ID',
    });
    return await new VenueManageService().companionRemove(this._user, input);
  }

  /** 拉黑签到用户 */
  async blockUser() {
    const input = this.validateData({
      checkin_id: 'must|string|name=签到记录ID',
      duration_days: 'int|default=7',
      reason: 'string|max:100|default=',
    });
    return await new VenueManageService().blockUser(this._user, input);
  }
}

module.exports = VenueManageController;
