const request = require('../../utils/request.js');

Page({
  data: {
    name: '',
    student_no: '',
    phone: '',
    college: '',
    role: 0,
    infoCompleted: false,
    locked: false, // 是否已锁定（信息已完善且角色无权修改）
    ready: false, // 是否已确认渲染表单（防闪现：已完善学生先 loading 后跳走，不渲染表单）
  },

  onLoad() {
    const app = getApp();
    const cached = app.getUserCache();

    // 【防闪现】缓存预判：已完善信息且无编辑权限（学生/普通管理员）→
    // 先不渲染表单（ready=false 显示骨架），异步确认后端后直接跳走。
    // 说明：storage 只是预判，真实状态以后端 my/profile 为准（见 loadProfile 内的缓存同步）。
    if (cached && cached.info_completed && Number(cached.role || 0) < 3) {
      this.loadProfile().then(() => {
        // 后端确认：仍为已完善 + 锁定 → 直接返回上一页，不渲染表单
        if (this.data.infoCompleted && this.data.role < 3) {
          this.goBack();
        }
        // 若后端返回未完善（缓存过期/被管理员重置）→ 已在 loadProfile 中 ready=true 渲染表单
      });
      return;
    }

    // 无缓存（含清除 storage 场景）/ 缓存未完善 / 有编辑权限（超管、人事）→ 正常加载渲染
    this.loadProfile();
  },

  /** 返回上一页；若本页是首个页面则回首页 tab */
  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  },

  async loadProfile() {
    try {
      const p = await request.call('my/profile', {}, { silent: true });
      const infoCompleted = !!p.info_completed;
      const role = Number(p.role) || 0;
      const locked = infoCompleted && role < 3;

      // 【后端为准】用后端结果同步更新本地缓存，避免旧缓存与后端不一致
      const app = getApp();
      const cached = app.getUserCache() || {};
      app.setUserCache(Object.assign({}, cached, {
        role: role,
        name: p.name || '',
        info_completed: infoCompleted,
      }));

      this.setData({
        name: p.name || '',
        student_no: p.student_no || '',
        phone: p.phone || '',
        college: p.college || '',
        role: role,
        infoCompleted: infoCompleted,
        locked: locked,
        ready: true,
      });
      return { infoCompleted: infoCompleted, role: role };
    } catch (e) {
      // 未注册用户可能无 profile；仍置 ready 避免一直骨架
      this.setData({ ready: true });
      return { infoCompleted: false, role: 0 };
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  async save() {
    if (this.data.locked) {
      wx.showToast({ title: '个人信息已锁定，请联系管理员修改', icon: 'none' });
      return;
    }
    const { name, student_no, phone, college } = this.data;
    if (!name || !student_no || !phone || !college) {
      wx.showToast({ title: '请填写完整信息', icon: 'none' });
      return;
    }
    if (!/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: '手机号格式错误', icon: 'none' });
      return;
    }
    try {
      await request.call('passport/save_profile', {
        name: name,
        student_no: student_no,
        phone: phone,
        college: college,
      });
      // 保存成功后同步更新本地缓存（info_completed=true），下次进入不再闪现
      const app = getApp();
      const cached = app.getUserCache() || {};
      app.setUserCache(Object.assign({}, cached, { info_completed: true, name: name }));

      wx.showToast({ title: '保存成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e) {
      // 错误已 toast
    }
  },
});
