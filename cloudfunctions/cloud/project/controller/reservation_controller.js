/**
 * reservation 控制器
 */
const BaseController = require('./base_controller.js');
const ReservationService = require('../service/reservation_service.js');

class ReservationController extends BaseController {
  async status() {
    const input = this.validateData({
      date: 'must|date|name=日期',
      slot_key: 'must|string|name=场次',
      venue_type: 'string|default=',
    });
    return await new ReservationService().status(input);
  }

  async create() {
    const input = this.validateData({
      date: 'must|date|name=日期',
      slot_key: 'must|string|name=场次',
      venue_key: 'must|string|name=场地',
    });
    return await new ReservationService().create(this._openId, this._user, input);
  }

  async cancel() {
    const input = this.validateData({
      res_id: 'must|string|name=预约ID',
    });
    return await new ReservationService().cancel(this._openId, input);
  }
}

module.exports = ReservationController;
