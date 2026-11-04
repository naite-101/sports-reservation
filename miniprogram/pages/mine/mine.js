const request = require('../../utils/request.js');

Page({
  data: {
    user: null,
    role: 0,
    roleName: '',
    blackDays: 0,
    stats: { total_count: 0, month_count: 0, no_show_count: 0 },
  },

  onShow() {
    this.init();
  },

  async init() {
    try {
      const login = await request.call('passport/login', {}, { silent: true });
      this.setData({
        role: login.role,
        roleName: login.role_name,
        blackDays: login.black_days || 0,
        user: login,
      });
    } catch (e) {
      // ignore
    }

    // 预约统计（需登录，匿名用户静默跳过）
    if (this.data.role >= 1) {
      try {
        const stats = await request.call('my/stats', {}, { silent: true });
        this.setData({ stats: stats || { total_count: 0, month_count: 0, no_show_count: 0 } });
      } catch (e) {}
    }
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  goReservations() {
    wx.navigateTo({ url: '/pages/my-reservations/my-reservations' });
  },

  goRecords() {
    wx.navigateTo({ url: '/pages/records/records' });
  },

  goQrcode() {
    if (this.data.blackDays > 0) {
      wx.showToast({ title: '您已被限制预约', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/qrcode/qrcode' });
  },

  goNotice() {
    wx.navigateTo({ url: '/pages/notice/notice' });
  },

  goAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  },

  goAdmin() {
    if (this.data.role < 2) {
      wx.showToast({ title: '无管理权限', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/admin/admin' });
  },
});
