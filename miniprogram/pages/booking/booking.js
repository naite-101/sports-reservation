const request = require('../../utils/request.js');
const util = require('../../utils/util.js');

const VENUE_TYPES = [
  { key: 'badminton', name: '羽毛球场' },
  { key: 'pingpong', name: '乒乓球场' },
  { key: 'gym', name: '健身房' },
];

Page({
  data: {
    types: VENUE_TYPES,
    activeType: 'badminton',
    date: '',
    slots: [],
    activeSlotKey: '',
    openTime: null,
    isToday: false,
    openReached: false,
    courts: [],
    selectedCourt: '',
    blackDays: 0,
    loading: true,
    // 人机验证码（防脚本抢预约）
    captchaVisible: false,
    captchaToken: '',
    captchaQuestion: '',
    captchaAnswer: '',
  },

  onLoad(options) {
    if (options && options.type) {
      this.setData({ activeType: options.type });
    }
  },

  onShow() {
    this.init();
  },

  async init() {
    try {
      const login = await request.call('passport/login', {}, { silent: true });
      this.setData({ blackDays: login.black_days || 0 });

      const slotData = await request.call('slot/list', {}, { silent: true });
      const now = new Date();
      const openMin = (slotData.open_time.hour || 0) * 60 + (slotData.open_time.minute || 0);
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const isToday = !!slotData.is_today;

      this.setData({
        date: slotData.date,
        slots: slotData.slots,
        openTime: slotData.open_time,
        isToday: isToday,
        openReached: isToday ? true : (nowMin >= openMin),
        activeSlotKey: slotData.slots.length ? slotData.slots[0].slot_key : '',
        loading: false,
      });
      this.loadCourts();
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  async loadCourts() {
    const { date, activeSlotKey, activeType } = this.data;
    if (!date || !activeSlotKey) return;
    try {
      const courts = await request.call('reservation/status', {
        date: date,
        slot_key: activeSlotKey,
        venue_type: activeType,
      });
      this.setData({ courts: courts, selectedCourt: '' });
    } catch (e) {
      this.setData({ courts: [] });
    }
  },

  onTapType(e) {
    this.setData({ activeType: e.currentTarget.dataset.type });
    this.loadCourts();
  },

  onTapSlot(e) {
    this.setData({ activeSlotKey: e.currentTarget.dataset.key });
    this.loadCourts();
  },

  onTapCourt(e) {
    const status = e.currentTarget.dataset.status;
    const key = e.currentTarget.dataset.key;
    if (status !== 'available') return;
    this.setData({ selectedCourt: key });
  },

  async confirmBooking() {
    if (this.data.blackDays > 0) {
      wx.showToast({ title: '您已被限制预约', icon: 'none' });
      return;
    }
    if (!this.data.openReached) {
      wx.showToast({ title: '未到预约开放时间', icon: 'none' });
      return;
    }
    const { date, activeSlotKey, selectedCourt } = this.data;
    if (!selectedCourt) {
      wx.showToast({ title: '请选择场地', icon: 'none' });
      return;
    }
    // 防脚本：提交前先弹出人机验证码，答对后才真正提交
    await this.fetchCaptcha();
  },

  /** 获取验证码并弹出验证框 */
  async fetchCaptcha() {
    try {
      const cap = await request.call('captcha/issue', {}, { silent: true });
      this.setData({
        captchaVisible: true,
        captchaToken: cap.token,
        captchaQuestion: cap.question,
        captchaAnswer: '',
      });
    } catch (e) {
      wx.showToast({ title: '验证码获取失败，请重试', icon: 'none' });
    }
  },

  /** 换一题（重新获取验证码） */
  async refreshCaptcha() {
    try {
      const cap = await request.call('captcha/issue', {}, { silent: true });
      this.setData({
        captchaToken: cap.token,
        captchaQuestion: cap.question,
        captchaAnswer: '',
      });
    } catch (e) {
      wx.showToast({ title: '刷新失败，请重试', icon: 'none' });
    }
  },

  onCaptchaInput(e) {
    this.setData({ captchaAnswer: e.detail.value });
  },

  closeCaptcha() {
    this.setData({ captchaVisible: false, captchaAnswer: '' });
  },

  onCaptchaMaskTap() {
    this.closeCaptcha();
  },

  noop() {},

  /** 验证码答对后真正提交预约 */
  async submitWithCaptcha() {
    const { date, activeSlotKey, selectedCourt, captchaToken, captchaAnswer } = this.data;
    const answer = String(captchaAnswer || '').trim();
    if (!answer) {
      wx.showToast({ title: '请输入验证码答案', icon: 'none' });
      return;
    }
    this.setData({ captchaVisible: false });
    wx.showLoading({ title: '提交中...' });
    try {
      await request.call('reservation/create', {
        date: date,
        slot_key: activeSlotKey,
        venue_key: selectedCourt,
        captcha_token: captchaToken,
        captcha_answer: answer,
      }, { silent: true });
      wx.hideLoading();
      wx.showModal({
        title: '预约成功',
        content: '场地 ' + selectedCourt + ' 预约成功',
        showCancel: false,
        success: () => {
          this.loadCourts();
        },
      });
    } catch (e) {
      wx.hideLoading();
      this.showBookingError(e);
      this.loadCourts();
    }
  },

  /** 预约失败时按错误码给出明确提示（silent 调用后自行 hideLoading+toast，避免提示被吞） */
  showBookingError(e) {
    const code = e && e.code;
    const titleMap = {
      4100: '该场地已被预约',
      4101: '您在该时段已预约其他场地',
      4102: '不在预约开放时间',
      4106: '该场地临时闭馆，不可预约',
      4010: '请先完善个人信息',
      4004: '您已被限制预约',
      4200: '请先完成人机验证',
      4201: '验证码已失效，请刷新后重试',
      4202: '验证码答案错误',
      4203: '操作过于频繁，请稍后再试',
    };
    const title = titleMap[code] || (e && e.msg) || '预约失败，请重试';
    wx.showToast({ title: title, icon: 'none', duration: 2500 });
  },
});
