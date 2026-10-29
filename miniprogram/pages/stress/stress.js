const request = require('../../utils/request.js');
const util = require('../../utils/util.js');

/**
 * 多微信号真人并发压测页（仅测试用）
 *
 * 用途：让多个真人（不同微信号、不同真实 openid）同时打开本页，
 *       约好时间一起点「抢」按钮，真实走 reservation/create，
 *       验证「同一场地同一场次，多人同时抢，只有 1 人成功」。
 *
 * 说明：
 *   - 这是唯一能真实复现「200 人抢同一场地」的方式：真人真微信真 openid，
 *     走的就是线上真实并发路径，服务端 _id 组合主键 + uniq_student_slot 唯一索引兜底。
 *   - 本地 mock / HTTP 外部压测都测不了这个（缺真实 openid）。
 */
Page({
  data: {
    user: null,
    date: '',
    slots: [],
    activeSlotKey: '',
    courts: [],
    targetCourt: '',      // 所有人抢的同一个场地
    openReached: false,
    loading: true,
    // 抢的结果
    lastResult: null,     // { ok, code, msg, at, cost }
    logs: [],             // 本机多次点击的历史
  },

  onLoad() {
    this.init();
  },

  async init() {
    try {
      const login = await request.call('passport/login', {}, { silent: true });
      // login 返回扁平结构 { openid, name, student_no?, info_completed, ... }
      this.setData({
        user: {
          name: login.name || '',
          student_no: login.student_no || '',
          info_completed: !!login.info_completed,
        },
      });

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
    const { date, activeSlotKey } = this.data;
    if (!date || !activeSlotKey) return;
    try {
      const courts = await request.call('reservation/status', {
        date: date,
        slot_key: activeSlotKey,
        venue_type: 'badminton',
      });
      // 默认抢第一个「可预约」的场地，让所有人都点同一个
      const available = courts.find((c) => c.status === 'available');
      this.setData({
        courts: courts,
        targetCourt: available ? available.venue_key : '',
      });
    } catch (e) {
      this.setData({ courts: [] });
    }
  },

  onTapSlot(e) {
    this.setData({ activeSlotKey: e.currentTarget.dataset.key });
    this.loadCourts();
  },

  /** 点「抢」：记录本地时刻 + 调真实预约接口 */
  async grab() {
    if (!this.data.openReached) {
      wx.showToast({ title: '未到预约开放时间', icon: 'none' });
      return;
    }
    const { date, activeSlotKey, targetCourt } = this.data;
    if (!targetCourt) {
      wx.showToast({ title: '没有可抢的场地', icon: 'none' });
      return;
    }

    const at = Date.now(); // 本地点击时刻（毫秒）
    wx.showLoading({ title: '抢场地中...' });
    let ok = false, code = '', msg = '';
    try {
      const res = await request.call('reservation/create', {
        date: date,
        slot_key: activeSlotKey,
        venue_key: targetCourt,
      }, { silent: true });
      ok = true;
      code = '200';
      msg = '抢到了！场地 ' + targetCourt;
    } catch (e) {
      code = String(e && e.code ? e.code : 'err');
      msg = codeText(code, e);
    } finally {
      wx.hideLoading();
    }
    const cost = Date.now() - at;

    const entry = { ok, code, msg, at, cost };
    const logs = [entry].concat(this.data.logs).slice(0, 50);
    this.setData({ lastResult: entry, logs: logs });

    // 刷新场地状态（别人可能已抢走）
    this.loadCourts();
  },

  /** 取消自己刚抢到的预约，便于重复测试 */
  async release() {
    const { date, activeSlotKey, targetCourt } = this.data;
    const resId = date + '_' + activeSlotKey + '_' + targetCourt;
    wx.showLoading({ title: '释放中...' });
    try {
      await request.call('reservation/cancel', { res_id: resId }, { silent: true });
      wx.showToast({ title: '已释放', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: '释放失败：' + (e.msg || ''), icon: 'none' });
    } finally {
      wx.hideLoading();
    }
    this.loadCourts();
  },
});

function codeText(code, e) {
  const map = {
    '4100': '场地已被别人抢走',
    '4101': '你已约了同时间窗其他场地',
    '4102': '不在开放时间',
    '4106': '场地闭馆',
    '4010': '请先完善个人信息',
    '4004': '你已被拉黑',
  };
  if (map[code]) return map[code];
  return (e && e.msg) ? e.msg : ('失败 code=' + code);
}
