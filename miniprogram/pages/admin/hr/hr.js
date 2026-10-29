const request = require('../../../utils/request.js');

const ROLE_TEXT = { 2: '普通管理员', 3: '超级管理员', 4: '老师', 5: '现任主席' };
// 每个角色「提升」按钮的文案（升到更高一级）；主席(5) 已最高，不再显示提升
const ROLE_UP_LABEL = { 2: '升为超管', 3: '升为老师', 4: '升为主席', 5: '' };

Page({
  data: {
    tab: 'admin',
    myRole: 0,
    admins: [],
    students: [],
    keyword: '',
    showAdd: false,
    adminForm: { openid: '', role: 2, name: '' },
    roleUpLabel: ROLE_UP_LABEL,
    editStudent: null,
    studentForm: { openid: '', name: '', student_no: '', phone: '', college: '' },
  },

  async onShow() {
    await this.initRole();
    this.load();
  },

  // 获取当前登录者角色，用于控制「学生管理」「移除」等仅人事管理员可见的入口
  async initRole() {
    try {
      const login = await request.call('passport/login', {}, { silent: true });
      this.setData({ myRole: login.role || 0 });
    } catch (e) {
      this.setData({ myRole: 0 });
    }
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
    this.load();
  },

  async load() {
    if (this.data.tab === 'admin') {
      try {
        const admins = await request.call('hr/admin_list', {}, { silent: true });
        this.setData({
          admins: admins.map((a) => Object.assign({}, a, { roleText: ROLE_TEXT[a.role] || a.role })),
        });
      } catch (e) {
        this.setData({ admins: [] });
      }
    } else {
      try {
        const data = await request.call('hr/student_list', { keyword: this.data.keyword, page: 1, size: 100 }, { silent: true });
        this.setData({ students: data.list || [] });
      } catch (e) {
        this.setData({ students: [] });
      }
    }
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  search() {
    this.load();
  },

  toggleAdd() {
    this.setData({ showAdd: !this.data.showAdd, adminForm: { openid: '', role: 2, name: '' } });
  },

  onAdminInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['adminForm.' + field]: e.detail.value });
  },

  async addAdmin() {
    const f = this.data.adminForm;
    if (!f.openid) {
      wx.showToast({ title: '请输入 openid', icon: 'none' });
      return;
    }
    try {
      await request.call('hr/admin_add', { openid: f.openid, role: Number(f.role), name: f.name });
      wx.showToast({ title: '已任免', icon: 'success' });
      this.setData({ showAdd: false });
      this.load();
    } catch (e) {}
  },

  async removeAdmin(e) {
    const openid = e.currentTarget.dataset.openid;
    const res = await new Promise((resolve) => {
      wx.showModal({ title: '移除管理员', content: '确定移除该管理员吗？', success: (r) => resolve(r.confirm) });
    });
    if (!res) return;
    try {
      await request.call('hr/admin_remove', { openid: openid });
      wx.showToast({ title: '已移除', icon: 'success' });
      this.load();
    } catch (err) {}
  },

  // 禁用/启用管理员（调用 hr/admin_assign）
  async toggleStatus(e) {
    const openid = e.currentTarget.dataset.openid;
    const status = Number(e.currentTarget.dataset.status);
    const role = Number(e.currentTarget.dataset.role);
    const next = status === 1 ? 0 : 1;
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: next === 1 ? '启用管理员' : '禁用管理员',
        content: next === 1 ? '确定启用该管理员吗？' : '确定禁用该管理员吗？禁用后无法登录管理后台。',
        success: (r) => resolve(r.confirm),
      });
    });
    if (!res) return;
    try {
      await request.call('hr/admin_assign', { openid: openid, role: role, status: next });
      wx.showToast({ title: '操作成功', icon: 'success' });
      this.load();
    } catch (err) {}
  },

  // 调整权限：逐级提升（普通管理员2 → 超管3 → 老师4 → 主席5）
  // 降级需求较小，前端仅提供「提升」；后端 hr/admin_assign 按操作者权限兜底校验
  async assignRole(e) {
    const openid = e.currentTarget.dataset.openid;
    const status = Number(e.currentTarget.dataset.status);
    const role = Number(e.currentTarget.dataset.role);
    if (role >= 5) return; // 主席已是最高权限，无可提升
    const next = role + 1;
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '调整权限',
        content: '确定将 ' + (ROLE_TEXT[role] || role) + ' 提升为 ' + (ROLE_TEXT[next] || next) + ' 吗？',
        success: (r) => resolve(r.confirm),
      });
    });
    if (!res) return;
    try {
      await request.call('hr/admin_assign', { openid: openid, role: next, status: status });
      wx.showToast({ title: '操作成功', icon: 'success' });
      this.load();
    } catch (err) {}
  },

  async editStudentTap(e) {
    const openid = e.currentTarget.dataset.openid;
    try {
      const s = await request.call('hr/student_detail', { openid: openid }, { silent: true });
      this.setData({
        editStudent: s,
        studentForm: { openid: s._id, name: s.name, student_no: s.student_no, phone: s.phone, college: s.college },
      });
    } catch (err) {}
  },

  onStudentInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['studentForm.' + field]: e.detail.value });
  },

  async saveStudent() {
    const f = this.data.studentForm;
    if (!f.name || !f.student_no || !f.phone || !f.college) {
      wx.showToast({ title: '请填写完整信息', icon: 'none' });
      return;
    }
    try {
      await request.call('hr/student_edit', f);
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ editStudent: null });
      this.load();
    } catch (e) {}
  },

  cancelEdit() {
    this.setData({ editStudent: null });
  },
});
