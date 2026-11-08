const request = require('../../utils/request.js');
const qrUtil = require('../../utils/qrcode.js');

Page({
  data: {
    booking: null,
    hasValid: false,
    countdown: 20,
    size: 220,
    loading: true, // 加载/刷新遮罩开关（canvas 始终存在，loading 覆盖其上）
  },

  onShow() {
    // 定时器仍在运行（页面未真正离开）时，不重复 start，避免反复请求 token
    if (this.timer) return;
    this.start();
  },

  onHide() {
    this.stop();
  },

  onUnload() {
    this.stop();
  },

  start() {
    this.refresh();
    this.timer = setInterval(() => {
      this.tick();
    }, 1000);
  },

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  tick() {
    let c = this.data.countdown - 1;
    if (c <= 0) {
      // 20 秒到点自动刷新（保留原逻辑）
      this.refresh();
    } else {
      this.setData({ countdown: c });
    }
  },

  async refresh() {
    this.setData({ loading: true });
    try {
      // 并行请求：valid_booking 与 generate 同时发起，消除串行等待（打开更快）
      const [valid, gen] = await Promise.all([
        request.call('qrcode/valid_booking', {}, { silent: true }),
        request.call('qrcode/generate', {}, { silent: true }),
      ]);
      this.setData({
        booking: valid && valid.has_valid ? valid.booking : null,
        hasValid: !!(valid && valid.has_valid),
        countdown: 20,
      });
      // canvas 绘制（异步提交渲染，绘制完成后移除遮罩）
      qrUtil.drawQrCode('qrcode', gen.token, this.data.size, this);
      this.setData({ loading: false });
    } catch (e) {
      // 出错即停止定时刷新，避免反复请求 token 造成无谓开销
      this.stop();
      this.setData({ loading: false, countdown: 20 });
      this.showQrError(e);
    }
  },

  /** 按后端错误码给出明确提示（拉黑/未完善信息/网络失败分别处理，避免二维码空白却无任何反馈） */
  showQrError(e) {
    const code = e && e.code;
    const days = e && e.data && e.data.black_days;
    if (code === 4004) {
      // 黑名单：后端已拦截，明确告知不可生成二维码
      const msg = days ? '您已被限制预约，' + days + ' 天内不可预约场馆，无法生成签到二维码' : '您已被限制预约，无法生成签到二维码';
      wx.showModal({ title: '无法生成二维码', content: msg, showCancel: false });
      return;
    }
    if (code === 4010) {
      // 未完善个人信息：引导去完善
      wx.showModal({
        title: '提示',
        content: '请先完善个人信息，再生成签到二维码',
        showCancel: false,
        success: () => wx.navigateTo({ url: '/pages/profile/profile' }),
      });
      return;
    }
    // 网络异常/其它：给出可重试提示
    wx.showToast({ title: (e && e.msg) || '网络异常，请重试', icon: 'none', duration: 2500 });
  },
});
