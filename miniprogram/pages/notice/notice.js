const request = require('../../utils/request.js');
const util = require('../../utils/util.js');

Page({
  data: {
    list: [],
    detail: null,
    page: 1,
    hasMore: true,
  },

  onLoad(options) {
    if (options && options.id) {
      this.loadDetail(options.id);
    } else {
      this.loadList();
    }
  },

  async loadList() {
    try {
      const data = await request.call('notice/list', { page: this.data.page, size: 20 }, { silent: true });
      const list = (data.list || []).map((n) =>
        Object.assign({}, n, { timeText: util.timestamp2Time(n.publish_time, 'Y-M-D h:m') })
      );
      this.setData({
        list: this.data.page === 1 ? list : this.data.list.concat(list),
        hasMore: this.data.page < data.count,
      });
    } catch (e) {
      this.setData({ list: [] });
    }
  },

  async loadDetail(id) {
    try {
      const detail = await request.call('notice/detail', { id: id }, { silent: true });
      this.setData({
        detail: Object.assign({}, detail, { timeText: util.timestamp2Time(detail.publish_time, 'Y-M-D h:m') }),
      });
      wx.setNavigationBarTitle({ title: detail.title || '公告详情' });
      // 标记已读：静默调用，失败不影响详情展示；成功后同步列表该条 is_read
      request.call('notice/read', { notice_id: id }, { silent: true })
        .then(() => {
          const list = this.data.list.map((it) =>
            it._id === id ? Object.assign({}, it, { is_read: true }) : it
          );
          this.setData({ list: list });
        })
        .catch(() => {});
    } catch (e) {
      // ignore
    }
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.detail) return;
    this.setData({ page: this.data.page + 1 });
    this.loadList();
  },

  onTapNotice(e) {
    const id = e.currentTarget.dataset.id;
    this.loadDetail(id);
  },

  onBack() {
    this.setData({ detail: null });
    wx.setNavigationBarTitle({ title: '公告' });
    // 从首页直达详情时未加载过列表，返回时补拉，避免空列表
    if (!this.data.list.length) this.loadList();
  },
});
