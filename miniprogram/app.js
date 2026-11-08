const config = require('./config/config.js');
const request = require('./utils/request.js');
const cache = require('./utils/cache.js');

const USER_CACHE_KEY = 'user_cache';
// 用户信息缓存 TTL（毫秒）：窗口内直接复用，避免每个页面 onShow 都重复调 passport/login。
// 仅作体验优化，业务权限一律以后端为准（见 refreshUserInfo 注释）。
const USER_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

App({
  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: '提示',
        content: '当前微信版本过低，无法使用云能力，请升级微信后重试',
        showCancel: false,
      });
      return;
    }
    wx.cloud.init({
      env: config.CLOUD_ID,
      traceUser: true,
    });
    // 登录初始化：冷启动异步拉取用户信息，同步写入 storage + 内存。
    // 供 profile / index / mine 等页面 onLoad 时【同步】读取，消除「先渲染再等接口」导致的闪现。
    this.refreshUserInfo();
  },

  globalData: {
    userInfo: null,
    role: 0,
    // 公告弹窗本次会话是否已弹出（用户点「我知道了」后置为 true；冷启动重置）
    noticePopped: false,
    // 首页轮播缓存（含临时链接 url，会话内复用避免重复请求）
    bannerCache: null,
    // 用户信息内存缓存时间戳（用于 TTL 判断，不落盘）
    _userCacheAt: 0,
  },

  /**
   * 同步读取用户缓存（内存 > storage）。无则返回 null。
   * 用于页面 onLoad/onShow 立即渲染，避免异步接口返回前的空白/闪现。
   */
  getUserCache() {
    if (this.globalData.userInfo) return this.globalData.userInfo;
    const c = cache.get(USER_CACHE_KEY, null);
    if (c) {
      this.globalData.userInfo = c;
      this.globalData.role = Number(c.role) || 0;
      this.globalData._userCacheAt = 0; // storage 命中但内存无时间戳，下次走刷新
    }
    return c;
  },

  /**
   * 写入用户缓存（storage + 内存）。login / save_profile 后调用。
   */
  setUserCache(user) {
    if (!user) return;
    this.globalData.userInfo = user;
    this.globalData.role = Number(user.role) || 0;
    this.globalData._userCacheAt = Date.now();
    cache.set(USER_CACHE_KEY, user);
  },

  /**
   * 刷新用户信息（以后端为准）。
   * TTL 内且已有缓存时直接复用，不发请求（减少重复 login）；
   * 超过 TTL 或 force=true 时强制重新请求，成功后更新缓存。
   *
   * ⚠️ 安全红线：此缓存只用于 UI 展示（角色名/黑名单提示条）。
   * 后端每个业务接口（预约/签到/二维码/黑名单拦截）仍会独立校验
   * info_completed、黑名单状态，绝不信任本缓存，因此 TTL 复用不会造成权限绕过。
   */
  async refreshUserInfo(force) {
    const now = Date.now();
    if (!force && this.globalData.userInfo && (now - this.globalData._userCacheAt) < USER_CACHE_TTL) {
      return this.globalData.userInfo;
    }
    try {
      const login = await request.call('passport/login', {}, { silent: true });
      this.setUserCache(login);
    } catch (e) {
      // 网络失败：保留旧缓存，页面仍可展示（业务权限由后端兜底）
    }
    return this.globalData.userInfo;
  },
});
