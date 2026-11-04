const config = require('./config/config.js');

App({
  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: '提示',
        content: '当前微信版本过低，无法使用云能力，请升级微信后重试',
        showCancel: false,
      });
      return;
    }
    wx.cloud.init({
      env: config.CLOUD_ID,
      traceUser: true,
    });
  },
  globalData: {
    userInfo: null,
    role: 0,
    // 公告弹窗本次会话是否已弹出（用户点「我知道了」后置为 true；冷启动重置）
    noticePopped: false,
    // 首页轮播缓存（含临时链接 url，会话内复用避免重复请求）
    bannerCache: null,
  },
});
