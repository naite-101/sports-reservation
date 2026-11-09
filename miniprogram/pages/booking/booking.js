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
    closedHint: '',
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
      const isToday = !!slotData.is_today;

      // L-9：开放判定以服务端 slot/list 为准（is_today/date 已由服务器按开放时间算好），
      //      不再用设备本地时间判断（防本地时钟不准导致按钮误禁用）
      this.setData({
        date: slotData.date,
        slots: slotData.slots,
        openTime: slotData.open_time,
        isToday: isToday,
        openReached: !!slotData.date,
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
      const courts = ((await request.call('reservation/status', {
        date: date,
        slot_key: activeSlotKey,
        venue_type: activeType,
      })) || []).map((c) => Object.assign({}, c, {
        // 闭馆场地的副标题（如「至19:35恢复」），可预约/已约满保持空串占位对齐
        closed_label: c.status === 'closed' && c.closed_until_text ? '至' + c.closed_until_text + '恢复' : '',
      }));
      this.setData({
        courts: courts,
        selectedCourt: '',
        closedHint: this.buildClosedHint(courts),
      });
    } catch (e) {
      this.setData({ courts: [], closedHint: '' });
    }
  },

  /**
   * 闭馆提示：服务端已按「场次开始时间 vs 恢复时刻」判定，
   * 这里只负责把「恢复之后开始的场次可约」讲清楚，避免学生误以为当天全锁。
   */
  buildClosedHint(courts) {
    const closed = (courts || []).filter((c) => c.status === 'closed');
    if (!closed.length) return '';
    // 恢复时刻可能因场地不同而不同，只有全部一致时才合并成一句
    const untils = closed.map((c) => c.closed_until_text).filter(Boolean);
    const unique = untils.filter((v, i) => untils.indexOf(v) === i);
    if (!unique.length) return closed.length + ' 块场地闭馆中，暂不可预约';
    if (unique.length > 1) return '部分场地闭馆中，恢复时刻之后开始的场次可正常预约';
    const until = unique[0];
    const prefix = closed.length === 1
      ? closed[0].court_no + ' 号场地闭馆至 ' + until
      : closed.length + ' 块场地闭馆至 ' + until;
    return prefix + '，' + until + ' 之后开始的场次可正常预约';
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
    const dataset = e.currentTarget.dataset;
    const status = dataset.status;
    if (status === 'closed') {
      const until = dataset.until;
      wx.showToast({
        title: until ? until + ' 之后开始的场次可预约' : '该场地闭馆中，暂不可预约',
        icon: 'none',
        duration: 2500,
      });
      return;
    }
    if (status === 'booked') {
      wx.showToast({ title: '该场地本场次已被预约', icon: 'none' });
      return;
    }
    this.setData({ selectedCourt: dataset.key });
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
    // 防脚本已改为「纯服务端窗口限流」（application 层 3 秒冷却），预约无需人机验证码，点一下直接提交。
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
      4203: '操作过于频繁，请稍后再试',
    };
    // 闭馆类错误用服务端文案（会带上「闭馆至 19:35」这类恢复时刻），其余用固定文案兜底
    let title = titleMap[code];
    if (code === 4106 && e && e.msg) title = e.msg;
    if (!title) title = (e && e.msg) || '预约失败，请重试';
    wx.showToast({ title: title, icon: 'none', duration: 2500 });
  },
});
