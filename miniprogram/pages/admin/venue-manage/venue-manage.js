/**
 * 场地管理（管理后台）
 * 入口：我的 → 管理后台 → 场地管理（所有管理员默认可见，普通用户无入口）
 *
 * 功能：后台签到 / 拉黑签到用户 / 查看签到人员信息 / 附属人员补录 / 列表区分人员来源
 * 说明：本页为增量新增页面，原有扫码签到、黑名单管理、签到记录等页面保持不动。
 */
const request = require('../../../utils/request.js');
const util = require('../../../utils/util.js');

const VENUE_TABS = [
  { key: '', name: '全部' },
  { key: 'badminton', name: '羽毛球' },
  { key: 'pingpong', name: '乒乓球' },
  { key: 'gym', name: '健身房' },
];

const EMPTY_STATS = { main: 0, onsite: 0, admin: 0, total: 0 };

function activeTypeName(key) {
  const hit = VENUE_TABS.filter((t) => t.key === key)[0];
  return hit && key ? hit.name : '全部场馆';
}

function confirmModal(title, content) {
  return new Promise((resolve) => {
    wx.showModal({
      title: title,
      content: content,
      confirmText: '确认',
      cancelText: '取消',
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false),
    });
  });
}

Page({
  data: {
    role: 0,
    ready: false,
    loaded: false,
    loading: false,

    date: util.today(),
    maxDate: util.today(),
    types: VENUE_TABS,
    activeType: '',
    activeTypeName: '全部场馆',

    list: [],
    stats: EMPTY_STATS,

    // 后台签到抽屉
    showCheckin: false,
    pendingList: [],
    pendingKeyword: '',
    pendingCount: 0,
    pendingLoading: false,

    // 附属人员扫码补录（无输入弹窗）
    scanning: false,

    // 拉黑弹窗
    showBlock: false,
    blockTarget: null,
    blockForm: { duration_days: 7, reason: '现场违规' },
    blocking: false,
  },

  onShow() {
    this.init();
  },

  onPullDownRefresh() {
    if (this.data.role < 2) {
      wx.stopPullDownRefresh();
      return;
    }
    this.load().then(() => wx.stopPullDownRefresh());
  },

  /* ---------------- 初始化与权限 ---------------- */

  async init() {
    // 页面级权限兜底：非管理员即使拿到路径也进不来（入口本身只在管理后台可见）
    let role = this.data.role;
    try {
      const login = await request.call('passport/login', {}, { silent: true });
      role = Number(login && login.role) || 0;
      this.setData({ role: role });
    } catch (e) {
      if (!this.data.ready) {
        wx.showToast({ title: '登录状态获取失败，请稍后重试', icon: 'none' });
      }
      return;
    }

    if (role < 2) {
      wx.showModal({
        title: '无权限',
        content: '仅管理员可进入场地管理',
        showCancel: false,
        success: () => wx.navigateBack(),
        fail: () => wx.navigateBack(),
      });
      return;
    }

    this.setData({ ready: true });
    this.load();
  },

  /* ---------------- 签到人员列表 ---------------- */

  async load() {
    if (this.data.role < 2) return;
    this.setData({ loading: true });
    try {
      const res = await request.call(
        'venue_manage/checkin_list',
        { date: this.data.date, venue_type: this.data.activeType },
        { silent: true }
      );
      const list = (res && res.list ? res.list : []).map((it) =>
        Object.assign({}, it, {
          companions: (it.companions || []).map((c) =>
            Object.assign({}, c, {
              sourceClass: c.source === 'admin' ? 'pill--admin' : 'pill--onsite',
            })
          ),
        })
      );
      this.setData({
        list: list,
        stats: (res && res.stats) || EMPTY_STATS,
        loading: false,
        loaded: true,
      });
    } catch (e) {
      this.setData({ list: [], stats: EMPTY_STATS, loading: false, loaded: true });
      wx.showToast({ title: (e && e.msg) || '加载失败，请重试', icon: 'none' });
    }
  },

  onDateChange(e) {
    const date = e.detail.value;
    this.setData({ date: date, loaded: false });
    this.load();
  },

  onTypeTap(e) {
    const key = e.currentTarget.dataset.key || '';
    this.setData({ activeType: key, activeTypeName: activeTypeName(key), loaded: false });
    this.load();
  },

  /* ---------------- 后台签到 ---------------- */

  openCheckin() {
    // 后台签到只针对当日预约（签到窗口按场次当天计算）
    if (this.data.date !== util.today()) {
      wx.showToast({ title: '仅可对当日预约发起后台签到', icon: 'none' });
      return;
    }
    this.setData({
      showCheckin: true,
      pendingKeyword: '',
      pendingList: [],
      pendingCount: 0,
    });
    this.loadPending();
  },

  closeCheckin() {
    this.setData({ showCheckin: false });
  },

  onPendingKeyword(e) {
    this.setData({ pendingKeyword: e.detail.value });
  },

  searchPending() {
    this.loadPending();
  },

  async loadPending() {
    this.setData({ pendingLoading: true });
    try {
      const res = await request.call(
        'venue_manage/pending_list',
        {
          date: this.data.date,
          venue_type: this.data.activeType,
          keyword: this.data.pendingKeyword,
        },
        { silent: true }
      );
      this.setData({
        pendingList: (res && res.list) || [],
        pendingCount: (res && res.can_count) || 0,
        pendingLoading: false,
      });
    } catch (e) {
      this.setData({ pendingList: [], pendingCount: 0, pendingLoading: false });
      wx.showToast({ title: (e && e.msg) || '加载失败，请重试', icon: 'none' });
    }
  },

  async doCheckin(e) {
    const resId = e.currentTarget.dataset.id;
    const item = this.data.pendingList.filter((x) => x.res_id === resId)[0];
    if (!item) return;
    if (!item.can_checkin) {
      wx.showToast({ title: item.state_text || '当前不可签到', icon: 'none' });
      return;
    }

    const ok = await confirmModal(
      '确认签到',
      '为 ' + (item.student_name || '该用户') + '（' + (item.student_no || '无学号') + '）办理「' +
        item.venue_text + ' ' + item.slot_text + '」签到？'
    );
    if (!ok) return;

    wx.showLoading({ title: '签到中...', mask: true });
    try {
      const r = await request.call(
        'venue_manage/checkin',
        { res_id: item.res_id, slot_key: item.slot_key },
        { silent: true }
      );
      wx.hideLoading();
      wx.showToast({ title: r && r.already ? '该用户已签到' : '签到成功', icon: 'success' });
      this.setData({ showCheckin: false });
      this.load();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: (err && err.msg) || '签到失败，请重试', icon: 'none', duration: 2500 });
    }
  },

  /* ---------------- 附属人员扫码补录 ---------------- */

  /**
   * 扫对方的「个人二维码」直接补录，不需要管理员输入姓名/电话
   * 后端校验动态码有效期与身份，重复/主签到人本人会被拦截
   */
  scanCompanion(e) {
    if (this.data.scanning) return;
    const ds = e.currentTarget.dataset;

    wx.scanCode({
      onlyFromCamera: true,
      success: (res) => {
        const token = res.result || '';
        if (!token) {
          wx.showToast({ title: '二维码内容为空', icon: 'none' });
          return;
        }
        this.doCompanionScan(token, ds.id, ds.name || '');
      },
      fail: () => {},
    });
  },

  async doCompanionScan(token, checkinId, mainName) {
    this.setData({ scanning: true });
    wx.showLoading({ title: '补录中...', mask: true });
    try {
      const data = await request.call(
        'venue_manage/companion_scan',
        { checkin_id: checkinId, token: token },
        { silent: true }
      );
      wx.hideLoading();
      const who = (data && data.name ? data.name : '该同学') +
        (data && data.student_no ? '（' + data.student_no + '）' : '');
      wx.showModal({
        title: '补录成功',
        content: who + ' 已加入' + (mainName ? '「' + mainName + '」' : '') + '的签到记录',
        showCancel: false,
        success: () => this.load(),
      });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: (e && e.msg) || '补录失败，请重试', icon: 'none', duration: 2500 });
    } finally {
      this.setData({ scanning: false });
    }
  },

  async removeCompanion(e) {
    const ds = e.currentTarget.dataset;
    const ok = await confirmModal('删除补录', '确定删除后台补录的「' + (ds.name || '') + '」吗？');
    if (!ok) return;
    try {
      await request.call('venue_manage/companion_remove', { companion_id: ds.id }, { silent: true });
      wx.showToast({ title: '已删除', icon: 'success' });
      this.load();
    } catch (err) {
      wx.showToast({ title: (err && err.msg) || '删除失败', icon: 'none' });
    }
  },

  /* ---------------- 拉黑 ---------------- */

  openBlock(e) {
    const ds = e.currentTarget.dataset;
    this.setData({
      showBlock: true,
      blockTarget: { checkin_id: ds.id, main_name: ds.name || '' },
      blockForm: { duration_days: 7, reason: '现场违规' },
    });
  },

  closeBlock() {
    this.setData({ showBlock: false });
  },

  onBlockInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['blockForm.' + field]: e.detail.value });
  },

  pickDays(e) {
    this.setData({ 'blockForm.duration_days': Number(e.currentTarget.dataset.days) });
  },

  async submitBlock() {
    if (this.data.blocking) return;
    const f = this.data.blockForm;
    const days = Number(f.duration_days);
    if (!(days > 0)) {
      wx.showToast({ title: '拉黑天数需大于 0', icon: 'none' });
      return;
    }

    this.setData({ blocking: true });
    try {
      await request.call(
        'venue_manage/block_user',
        {
          checkin_id: this.data.blockTarget.checkin_id,
          duration_days: days,
          reason: String(f.reason || '').trim(),
        },
        { silent: true }
      );
      this.setData({ showBlock: false, blocking: false });
      wx.showToast({ title: '已拉黑', icon: 'success' });
      this.load();
    } catch (e) {
      this.setData({ blocking: false });
      wx.showToast({ title: (e && e.msg) || '拉黑失败，请重试', icon: 'none', duration: 2500 });
    }
  },

  /** 阻止弹层内部点击冒泡到遮罩 */
  noop() {},
});
