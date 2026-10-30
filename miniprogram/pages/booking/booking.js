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
    wx.showLoading({ title: '提交中...' });
    try {
      await request.call('reservation/create', {
        date: date,
        slot_key: activeSlotKey,
        venue_key: selectedCourt,
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
    };
    const title = titleMap[code] || (e && e.msg) || '预约失败，请重试';
    wx.showToast({ title: title, icon: 'none', duration: 2500 });
  },
});
