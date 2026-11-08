const request = require('../../utils/request.js');

Page({
  data: {
    user: null,
    role: 0,
    roleName: '',
    blackDays: 0,
    stats: { total_count: 0, month_count: 0, no_show_count: 0 },
    loaded: false, // 骨架屏开关：首次无缓存时占位，避免布局塌陷抖动
  },

  onShow() {
    this.init();
  },

  async init() {
    const app = getApp();

    // 1. 缓存优先渲染：有用户缓存先同步填充，消除「user=null 导致布局抖动/空白」
    const cached = app.getUserCache();
    if (cached) {
      this.setData({
        role: Number(cached.role) || 0,
        roleName: cached.role_name || '',
        blackDays: cached.black_days || 0,
        user: cached,
        loaded: true,
      });
    }

    // 2. 后端为准：异步刷新 login（app.refreshUserInfo 带 TTL 去重，切 tab 不再重复请求）
    try {
      const login = await app.refreshUserInfo();
      if (login) {
        this.setData({
          role: Number(login.role) || 0,
          roleName: login.role_name || '',
          blackDays: login.black_days || 0,
          user: login,
        });
      }
    } catch (e) {
      // 网络失败静默：沿用缓存展示
    }

    // 3. 预约统计（独立 setData，与上面拆分，避免一次性大对象更新触发全页重渲染）
    if (this.data.role >= 1) {
      try {
        const stats = await request.call('my/stats', {}, { silent: true });
        this.setData({ stats: stats || { total_count: 0, month_count: 0, no_show_count: 0 } });
      } catch (e) {}
    }

    this.setData({ loaded: true });
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
