/**
 * hr 控制器：人事管理
 */
const BaseController = require('./base_controller.js');
const HrService = require('../service/hr_service.js');

class HrController extends BaseController {
  async adminList() {
    return await new HrService().adminList(this._user);
  }

  async adminAdd() {
    const input = this.validateData({
      openid: 'string|default=',
      keyword: 'string|default=',
      role: 'must|int|name=角色',
      name: 'string|default=',
    });
    return await new HrService().adminAdd(this._user, input);
  }

  async adminRemove() {
    const input = this.validateData({ openid: 'must|string|name=openid' });
    return await new HrService().adminRemove(this._user, input);
  }

  async adminAssign() {
    const input = this.validateData({
      openid: 'must|string|name=openid',
      role: 'must|int|name=角色',
      status: 'int|default=1',
    });
    return await new HrService().adminAssign(this._user, input);
  }

  async studentList() {
    const input = this.validateData({
      keyword: 'string|default=',
      page: 'int|default=1',
      size: 'int|default=20',
    });
    return await new HrService().studentList(input);
  }

  async studentDetail() {
    const input = this.validateData({ openid: 'must|string|name=openid' });
    return await new HrService().studentDetail(input.openid);
  }

  async studentEdit() {
    const input = this.validateData({
      openid: 'must|string|name=openid',
      name: 'must|string|min:1|max:20|name=姓名',
      student_no: 'must|string|min:1|max:30|name=学号',
      phone: 'must|mobile|name=手机号',
      college: 'must|string|min:1|max:50|name=学院',
    });
    return await new HrService().studentEdit(this._user, input);
  }
}

module.exports = HrController;
