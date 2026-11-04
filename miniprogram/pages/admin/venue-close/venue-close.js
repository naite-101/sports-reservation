const request = require('../../../utils/request.js');
const util = require('../../../utils/util.js');

const VENUE_TYPES = [
  { key: 'badminton', name: '羽毛球场' },
  { key: 'pingpong', name: '乒乓球场' },
  { key: 'gym', name: '健身房' },
];

Page({
  data: {
    types: VENUE_TYPES,
    activeType: 'badminton',
    list: [],
    // 临时闭馆时间选择面板
    showClosePanel: false,
    closeKey: '',
    closeDateRange: ['今天', '明天'],
    closeDateIndex: 0,
    closeTime: '23:59',
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      const venues = await request.call('venue/list', {}, { silent: true });
      const group = venues.find((v) => v.venue_type === this.data.activeType);
      const courts = (group ? group.courts : []).map((c) =>
        Object.assign({}, c, {
          closedUntilText: c.closed_until ? util.timestamp2Time(c.closed_until, 'M-D h:m') : '',
        })
      );
      this.setData({ list: courts });
    } catch (e) {
      this.setData({ list: [] });
    }
  },

  onTapType(e) {
    this.setData({ activeType: e.currentTarget.dataset.key });
    this.load();
  },

  async toggle(e) {
    const key = e.currentTarget.dataset.key;
    const closed = e.currentTarget.dataset.closed;

    // 恢复开放：直接确认，closed_until 传 0 表示永久恢复
    if (closed) {
      const ok = await this.confirmModal('恢复开放', '确定恢复该场地开放吗？');
      if (!ok) return;
      try {
        await request.call('venue/close', { venue_key: key, closed: false, closed_until: 0 });
        wx.showToast({ title: '已恢复开放', icon: 'success' });
        this.load();
      } catch (err) {}
      return;
    }

    // 闭馆：先选择「临时闭馆」还是「永久闭馆」
    const mode = await new Promise((resolve) => {
      wx.showActionSheet({
        itemList: ['临时闭馆（选恢复时间）', '永久闭馆（手动恢复）'],
        success: (r) => resolve(r.tapIndex),
        fail: () => resolve(-1),
      });
    });
    if (mode === -1) return;

    // 永久闭馆：closed_until 传 0
    if (mode === 1) {
      const ok = await this.confirmModal('永久闭馆', '确定永久闭馆该场地吗？需手动点击「恢复」重新开放。');
      if (!ok) return;
      try {
        await request.call('venue/close', { venue_key: key, closed: true, closed_until: 0 });
        wx.showToast({ title: '已闭馆', icon: 'success' });
        this.load();
      } catch (err) {}
      return;
    }

    // 临时闭馆：弹出时间选择面板，默认恢复时间为 2 小时后
    const def = new Date(Date.now() + 2 * 60 * 60 * 1000);
    this.setData({
      showClosePanel: true,
      closeKey: key,
      closeDateIndex: 0,
      closeTime: util.pad2(def.getHours()) + ':' + util.pad2(def.getMinutes()),
    });
  },

  confirmModal(title, content) {
    return new Promise((resolve) => {
      wx.showModal({
        title: title,
        content: content,
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
  },

  onCloseDateChange(e) {
    this.setData({ closeDateIndex: Number(e.detail.value) });
  },

  onCloseTimeChange(e) {
    this.setData({ closeTime: e.detail.value });
  },

  cancelClose() {
    this.setData({ showClosePanel: false, closeKey: '' });
  },

  async confirmClose() {
    const key = this.data.closeKey;
    if (!key) return;
    const parts = String(this.data.closeTime || '').split(':');
    const hh = Number(parts[0]);
    const mm = Number(parts[1]);
    if (isNaN(hh) || isNaN(mm)) {
      wx.showToast({ title: '请选择恢复时间', icon: 'none' });
      return;
    }

    const d = new Date();
    if (this.data.closeDateIndex === 1) d.setDate(d.getDate() + 1);
    d.setHours(hh, mm, 0, 0);
    const closedUntil = d.getTime();
    if (closedUntil <= Date.now()) {
      wx.showToast({ title: '恢复时间需晚于当前时间', icon: 'none' });
      return;
    }

    const text = util.timestamp2Time(closedUntil, 'Y-M-D h:m');
    const ok = await this.confirmModal('临时闭馆', '确定闭馆至 ' + text + ' 吗？');
    if (!ok) return;

    try {
      await request.call('venue/close', { venue_key: key, closed: true, closed_until: closedUntil });
      wx.showToast({ title: '已闭馆', icon: 'success' });
      this.setData({ showClosePanel: false, closeKey: '' });
      this.load();
    } catch (err) {}
  },
});
