const request = require('../../utils/request.js');
const util = require('../../utils/util.js');

Page({
  data: {
    role: 0,
    blackDays: 0,
    venues: [],
    myReservation: null, // 最近一条待使用的预约（用于首页展示）
    banners: [],
    noticeList: [], // 首页公告区最近 3 条（含已读/未读与日期）
    loading: true,
    showNotice: false,
    notice: null,
    // 本地默认轮播图（无云端 banner 时兜底展示）
    localBanners: [
      { id: 'local1', src: '/images/banner_1.jpg', mode: 'aspectFit' },
      { id: 'local2', src: '/images/banner_2.jpg', mode: 'aspectFit' },
      { id: 'local3', src: '/images/banner_3.jpg', mode: 'aspectFill' },
    ],
  },

  onShow() {
    this.init();
  },

  async init() {
    try {
      const login = await request.call('passport/login', {}, { silent: true });
      this.setData({
        role: login.role,
        blackDays: login.black_days || 0,
      });
      const app = getApp();
      app.globalData.role = login.role;
      app.globalData.userInfo = login;
    } catch (e) {
      // 静默处理，页面仍可展示
    }

    // 场馆（需登录，匿名用户静默跳过）
    try {
      const venues = await request.call('venue/list', {}, { silent: true });
      this.setData({ venues: venues || [] });
    } catch (e) {}

    // 我的预约（选离现在最近、尚未结束的一场，用于「选择场馆」标题旁的简讯）
    try {
      const list = await request.call('my/reservations', {}, { silent: true });
      this.setData({ myReservation: this.formatNearestReservation(list || []) });
    } catch (e) {}

    // 首页轮播（会话内缓存：已预取过临时链接就直接复用，避免每次切回首页都重新请求）
    try {
      const app = getApp();
      if (app.globalData.bannerCache) {
        this.setData({ banners: app.globalData.bannerCache });
      } else {
        const banners = await request.call('banner/list', {}, { silent: true });
        const list = banners || [];
        this.setData({ banners: list });
        // 预取临时链接缓存到 item.url，并按宽高比归一化展示模式（点击放大秒开）
        this.prepareBanners(list);
      }
    } catch (e) {}

    // 首页公告区（最近 3 条，带已读/未读与中文日期）
    try {
      const noticeListRes = await request.call('notice/list', { page: 1, size: 3 }, { silent: true });
      const noticeList = ((noticeListRes && noticeListRes.list) || []).map((n) =>
        Object.assign({}, n, { dateText: util.timestamp2TimeCn(n.publish_time) })
      );
      this.setData({ noticeList: noticeList });
    } catch (e) {}

    // 最新公告弹窗：每次冷启动弹一次，用户点「我知道了」后本次会话不再弹（见 onCloseNotice）
    try {
      const app = getApp();
      const latest = await request.call('notice/latest', {}, { silent: true });
      if (latest && latest._id && !app.globalData.noticePopped) {
        this.setData({ showNotice: true, notice: latest });
      }
    } catch (e) {}

    this.setData({ loading: false });
  },

  onCloseNotice() {
    // 用户关闭弹窗（点「我知道了」或「查看详情」）后，本次会话不再弹
    getApp().globalData.noticePopped = true;
    this.setData({ showNotice: false });
  },

  /** 预取轮播图临时链接缓存到 item.url，并按宽高比归一化展示模式（点击放大秒开） */
  prepareBanners(banners) {
    if (!banners || !banners.length) return;
    const fileIDs = banners.map((item) => item.fileID).filter(Boolean);
    if (!fileIDs.length) {
      this.normalizeBannerMode(banners);
      return;
    }
    wx.cloud.getTempFileURL({
      fileList: fileIDs,
      success: (res) => {
        const map = {};
        (res.fileList || []).forEach((f) => {
          if (f.tempFileURL) map[f.fileID] = f.tempFileURL;
        });
        banners.forEach((item) => {
          if (map[item.fileID]) item.url = map[item.fileID];
        });
        this.setData({ banners: banners });
        getApp().globalData.bannerCache = banners;
        this.normalizeBannerMode(banners);
      },
      fail: () => {
        // 转换失败则仍按原 fileID 展示，点击时再现场兜底
        this.normalizeBannerMode(banners);
      },
    });
  },

  /** 按图片宽高比归一化轮播展示模式（横图填满、方图/竖图完整显示） */
  normalizeBannerMode(banners) {
    if (!banners || !banners.length) return;
    banners.forEach((item) => {
      const src = item.url || item.fileID;
      if (!src) {
        item.mode = 'aspectFit';
        return;
      }
      wx.getImageInfo({
        src: src,
        success: (info) => {
          const mode = info.width > info.height ? 'aspectFill' : 'aspectFit';
          this.setData({ [`banners[${banners.indexOf(item)}].mode`]: mode });
        },
        fail: () => {
          // 获取失败则默认完整显示，避免裁剪
        },
      });
    });
  },

  /** 点击轮播图放大预览（优先用已缓存的临时链接，秒开；cloud:// 未就绪时现场兜底） */
  onTapBanner(e) {
    const index = Number(e.currentTarget.dataset.index) || 0;
    const isCloud = this.data.banners && this.data.banners.length > 0;
    const list = isCloud ? this.data.banners : this.data.localBanners;
    const urls = list.map((item) => item.url || item.fileID || item.src).filter(Boolean);
    if (!urls.length) return;
    const current = urls[index] || urls[0];
    // 仍是 cloud:// 文件 ID（预取未完成/失败）时，现场转一次
    if (current.indexOf('cloud://') === 0) {
      wx.cloud.getTempFileURL({
        fileList: [current],
        success: (res) => {
          const u = res.fileList && res.fileList[0] && res.fileList[0].tempFileURL;
          if (u) {
            wx.previewImage({ current: u, urls: [u] });
          } else {
            wx.showToast({ title: '图片加载失败', icon: 'none' });
          }
        },
        fail: () => {
          wx.showToast({ title: '图片加载失败', icon: 'none' });
        },
      });
      return;
    }
    wx.previewImage({ current: current, urls: urls });
  },

  onTapVenue(e) {
    const type = e.currentTarget.dataset.type;
    if (this.data.blackDays > 0) {
      wx.showToast({ title: '您已被限制预约', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/booking/booking?type=' + type });
  },

  /** 把一条预约记录格式化成首页展示所需的精简字段 */
  formatReservation(r) {
    if (!r) return null;
    let slotText = r.slot_key || '';
    // slot_key 形如 "1820_1930" -> "18:20-19:30"
    const m = /^(\d{2})(\d{2})_(\d{2})(\d{2})$/.exec(String(r.slot_key || ''));
    if (m) {
      slotText = `${m[1]}:${m[2]}-${m[3]}:${m[4]}`;
    }
    return {
      venue_type_name: r.venue_type_name || '',
      court_no: r.court_no,
      date: r.date || '',
      slotText: slotText,
    };
  },

  /** 从预约列表里选出离现在最近、尚未结束的一场（按场次开始时间升序，就近场次结束后自动显示下一场） */
  formatNearestReservation(list) {
    const candidates = (list || [])
      .filter((r) => r.status === 'pending')
      .map((r) => {
        const si = util.parseSlotKey(r.slot_key);
        let startTs = Infinity;
        if (si) {
          const p = String(r.date || '').split('-').map(Number);
          if (p.length === 3) {
            startTs = new Date(p[0], p[1] - 1, p[2], 0, 0, 0).getTime() + si.start_min * 60 * 1000;
          }
        }
        return { record: r, startTs: startTs };
      })
      .sort((a, b) => a.startTs - b.startTs);
    const nearest = candidates.length ? candidates[0].record : null;
    return this.formatReservation(nearest);
  },

  goReservations() {
    wx.navigateTo({ url: '/pages/my-reservations/my-reservations' });
  },

  goQrcode() {
    if (this.data.blackDays > 0) {
      wx.showToast({ title: '您已被限制预约，二维码不可用', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/qrcode/qrcode' });
  },

  goNotice() {
    wx.navigateTo({ url: '/pages/notice/notice' });
  },

  onTapNotice(e) {
    const id = e.currentTarget.dataset.id;
    if (id) {
      // 本地乐观更新：点击即标记已读，返回首页立即显示「已读」（后端 notice/read 仍会云端落库）
      const noticeList = this.data.noticeList.map((it) =>
        it._id === id ? Object.assign({}, it, { is_read: true }) : it
      );
      this.setData({ noticeList: noticeList });
      wx.navigateTo({ url: '/pages/notice/notice?id=' + id });
    }
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },
});
