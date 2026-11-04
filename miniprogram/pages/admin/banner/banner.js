const request = require('../../../utils/request.js');

Page({
  data: {
    role: 0,
    banners: [],
  },

  onShow() {
    this.init();
  },

  async init() {
    let role = 0;
    try {
      const login = await request.call('passport/login', {}, { silent: true });
      role = login.role || 0;
    } catch (e) {
      role = 0;
    }
    this.setData({ role: role });
    if (role < 3) {
      wx.showToast({ title: '无权限', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.load();
  },

  async load() {
    try {
      const banners = await request.call('banner/list', {}, { silent: true });
      this.setData({ banners: banners || [] });
    } catch (e) {
      this.setData({ banners: [] });
    }
  },

  chooseAndUpload() {
    if (this.data.role < 3) {
      wx.showToast({ title: '无权限', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => this.upload(res),
      fail: () => {},
    });
  },

  async upload(res) {
    const filePath = res.tempFiles && res.tempFiles[0] ? res.tempFiles[0].tempFilePath : '';
    if (!filePath) {
      wx.showToast({ title: '未获取到图片', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '上传中...', mask: true });
    try {
      const extMatch = /\.(\w+)$/.exec(filePath);
      const ext = extMatch ? extMatch[1] : 'jpg';
      const cloudPath = 'banners/' + Date.now() + '-' + Math.floor(Math.random() * 100000) + '.' + ext;

      // 1) 上传到云存储
      let fileID = '';
      try {
        fileID = await new Promise((resolve, reject) => {
          wx.cloud.uploadFile({
            cloudPath: cloudPath,
            filePath: filePath,
            success: (r) => resolve(r.fileID),
            fail: (err) => reject(err),
          });
        });
      } catch (uploadErr) {
        wx.hideLoading();
        wx.showToast({ title: '图片上传失败，请检查网络后重试', icon: 'none', duration: 3000 });
        return;
      }
      if (!fileID) throw new Error('uploadFile 未返回 fileID');

      // 2) 写库（silent，成功/失败都在下方统一提示，避免与 request 内置 toast 重复弹）
      await request.call('banner/add', { fileID: fileID }, { silent: true });
      wx.hideLoading();
      wx.showToast({ title: '已添加', icon: 'success' });
      this.load();
    } catch (e) {
      wx.hideLoading();
      const msg = (e && e.msg) || (e && e.errMsg) || '上传失败，请重试';
      wx.showToast({ title: msg, icon: 'none', duration: 3000 });
    }
  },

  onRemove(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除轮播图',
      content: '确定删除这张轮播图吗？',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await request.call('banner/delete', { id: id });
          wx.showToast({ title: '已删除', icon: 'success' });
          this.load();
        } catch (err) {}
      },
    });
  },

  async onMove(e) {
    const index = Number(e.currentTarget.dataset.index);
    const dir = Number(e.currentTarget.dataset.dir);
    const list = this.data.banners.slice();
    const target = index + dir;
    if (target < 0 || target >= list.length) return;
    const tmp = list[index];
    list[index] = list[target];
    list[target] = tmp;
    this.setData({ banners: list });
    try {
      await request.call('banner/sort', { ids: list.map((b) => b._id) });
    } catch (err) {
      this.load();
    }
  },
});
