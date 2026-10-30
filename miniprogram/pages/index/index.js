const request = require('../../utils/request.js');

Page({
  data: {
    role: 0,
    blackDays: 0,
    venues: [],
    showNotice: false,
    notice: null,
    loading: true,
  },

  onShow() {
    this.init();
  },

  async init() {
    try {
      const login = await request.call('passport/login', {}, { silent: true });
      this.setData({
        role: login.role,
        blackDays: login.black_days || 0,
      });
      const app = getApp();
      app.globalData.role = login.role;
      app.globalData.userInfo = login;

      const venues = await request.call('venue/list', {}, { silent: true });
      this.setData({ venues: venues });

      const notice = await request.call('notice/latest', {}, { silent: true });
      if (notice && notice._id) {
        // 本次会话内同一公告只弹一次，避免切页后重复弹出；公告更新（新 _id）仍会弹出
        if (app.globalData.shownNoticeId !== notice._id) {
          app.globalData.shownNoticeId = notice._id;
          this.setData({ notice: notice, showNotice: true });
        }
      }
    } catch (e) {
      // 静默处理，页面仍可展示
    } finally {
      this.setData({ loading: false });
    }
  },

  onCloseNotice() {
    this.setData({ showNotice: false });
  },

  onTapVenue(e) {
    const type = e.currentTarget.dataset.type;
    if (this.data.blackDays > 0) {
      wx.showToast({ title: '您已被限制预约', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/booking/booking?type=' + type });
  },

  goReservations() {
    wx.navigateTo({ url: '/pages/my-reservations/my-reservations' });
  },

  goQrcode() {
    if (this.data.blackDays > 0) {
      wx.showToast({ title: '您已被限制预约，二维码不可用', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/qrcode/qrcode' });
  },

  goNotice() {
    wx.navigateTo({ url: '/pages/notice/notice' });
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },
});
