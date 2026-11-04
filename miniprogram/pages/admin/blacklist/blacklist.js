const request = require('../../../utils/request.js');
const util = require('../../../utils/util.js');

Page({
  data: {
    role: 0,
    list: [],
    showAdd: false,
    addForm: { student_openid: '', duration_days: 7, reason: '' },
  },

  onShow() {
    this.init();
  },

  async init() {
    try {
      const login = await request.call('passport/login', {}, { silent: true });
      this.setData({ role: login.role });
    } catch (e) {}
    this.load();
  },

  async load() {
    try {
      const list = await request.call('blacklist/list', {}, { silent: true });
      this.setData({
        list: list.map((b) =>
          Object.assign({}, b, {
            startText: util.timestamp2Time(b.start_time, 'Y-M-D h:m'),
            endText: util.timestamp2Time(b.end_time, 'Y-M-D h:m'),
          })
        ),
      });
    } catch (e) {
      this.setData({ list: [] });
    }
  },

  toggleAdd() {
    this.setData({ showAdd: !this.data.showAdd });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['addForm.' + field]: e.detail.value });
  },

  async submitAdd() {
    const f = this.data.addForm;
    if (!f.student_openid) {
      wx.showToast({ title: '请输入学号 / 姓名 / openid', icon: 'none' });
      return;
    }
    try {
      await request.call('blacklist/add', {
        student_openid: f.student_openid,
        duration_days: Number(f.duration_days),
        reason: f.reason,
      });
      wx.showToast({ title: '已拉黑', icon: 'success' });
      this.setData({ showAdd: false, addForm: { student_openid: '', duration_days: 7, reason: '' } });
      this.load();
    } catch (e) {}
  },

  async release(e) {
    const id = e.currentTarget.dataset.id;
    const res = await new Promise((resolve) => {
      wx.showModal({ title: '解除拉黑', content: '确定提前解除该学生的拉黑吗？', success: (r) => resolve(r.confirm) });
    });
    if (!res) return;
    try {
      await request.call('blacklist/release', { blacklist_id: id, reason: '管理员手动解除' });
      wx.showToast({ title: '已解除', icon: 'success' });
      this.load();
    } catch (err) {}
  },
});
