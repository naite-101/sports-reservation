const request = require('../../../utils/request.js');

Page({
  data: {
    scanResult: null,
    companions: [{ name: '', phone: '' }],
    checking: false,
  },

  scan() {
    wx.scanCode({
      onlyFromCamera: true,
      success: async (res) => {
        const token = res.result || '';
        if (!token) {
          wx.showToast({ title: '二维码内容为空', icon: 'none' });
          return;
        }
        wx.showLoading({ title: '校验中...' });
        try {
          const data = await request.call('admin/scan', { token: token }, { silent: true });
          wx.hideLoading();
          this.setData({ scanResult: data, companions: [{ name: '', phone: '' }] });
        } catch (e) {
          wx.hideLoading();
          this.setData({ scanResult: null });
          wx.showToast({
            title: (e && e.msg) || (e && e.errMsg) || '扫描失败，请重试',
            icon: 'none',
            duration: 2500,
          });
        }
      },
      fail: () => {},
    });
  },

  addCompanion() {
    this.setData({ companions: this.data.companions.concat([{ name: '', phone: '' }]) });
  },

  removeCompanion(e) {
    const i = e.currentTarget.dataset.index;
    const list = this.data.companions.slice();
    list.splice(i, 1);
    if (!list.length) list.push({ name: '', phone: '' });
    this.setData({ companions: list });
  },

  onCompanionInput(e) {
    const i = e.currentTarget.dataset.index;
    const field = e.currentTarget.dataset.field;
    const list = this.data.companions.slice();
    list[i][field] = e.detail.value;
    this.setData({ companions: list });
  },

  async confirm() {
    if (!this.data.scanResult) return;
    if (this.data.checking) return;
    const companions = this.data.companions
      .filter((c) => c.name && c.name.trim())
      .map((c) => ({ name: c.name.trim(), phone: c.phone || '' }));

    this.setData({ checking: true });
    try {
      const res = await request.call('admin/checkin', {
        res_id: this.data.scanResult.booking.res_id,
        slot_key: this.data.scanResult.booking.slot_key,
        companions: companions,
      });
      this.setData({ checking: false });
      wx.showModal({
        title: '签到成功',
        content: '签到完成，附属人员 ' + companions.length + ' 人',
        showCancel: false,
        success: () => {
          this.setData({ scanResult: null });
        },
      });
    } catch (e) {
      this.setData({ checking: false });
    }
  },
});
