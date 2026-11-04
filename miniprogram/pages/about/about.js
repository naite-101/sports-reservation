// 关于小程序：展示版本信息与功能入口
Page({
  data: {
    // 版本号写死，后续发版时统一更新
    version: 'v1.0.0',
  },

  // 跳转：建议 / 问题反馈
  goFeedback() {
    wx.navigateTo({ url: '/pages/feedback/feedback' });
  },

  // 跳转：开发者信息
  goDeveloper() {
    wx.navigateTo({ url: '/pages/developer/developer' });
  },
});
