/**
 * 轻量缓存工具：storage 持久化 + 内存 Map 双层缓存
 *
 * ⚠️ 安全红线：本缓存【仅用于提升体验、消除页面闪现/抖动】，
 * 绝不作为业务权限判断依据。所有预约、签到、二维码、黑名单、
 * info_completed 等权限，一律以后端接口返回为准，前端缓存可被
 * 用户清除或篡改，不可信任。
 */

const PREFIX = 'gym_';

// 内存缓存（会话内，避免反复同步读 storage）
const mem = {};

/** 读缓存：内存优先，其次 storage，无则返回默认值 def */
function get(key, def) {
  const k = PREFIX + key;
  if (mem[k] !== undefined) return mem[k];
  try {
    const v = wx.getStorageSync(k);
    if (v === '' || v === undefined || v === null) return def;
    mem[k] = v;
    return v;
  } catch (e) {
    return def;
  }
}

/** 写缓存：同时写内存与 storage */
function set(key, val) {
  const k = PREFIX + key;
  mem[k] = val;
  try {
    wx.setStorageSync(k, val);
  } catch (e) {
    // storage 写失败（如超限）忽略，内存缓存仍生效
  }
}

/** 删除缓存 */
function remove(key) {
  const k = PREFIX + key;
  delete mem[k];
  try {
    wx.removeStorageSync(k);
  } catch (e) {}
}

module.exports = {
  get: get,
  set: set,
  remove: remove,
};
