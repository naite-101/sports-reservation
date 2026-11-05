/**
 * 全局配置：云环境、角色常量、集合名、场馆/场次常量、默认配置
 * 部署时必须填写 CLOUD_ID（与 miniprogram/config/config.js 保持一致）
 */
module.exports = {
  // TODO: 部署时填写你的云环境 ID
  CLOUD_ID: 'zd-tiyuguan-dev-d0f7ou1xabb04937',

  // 定时任务 / init 手动调用密钥（仅在云函数内部使用，勿泄露到前端）
  JOB_SECRET: 'gymreserve-job-secret-2026',

  // 角色常量（数值越大权限越高）
  // 说明：老师/主席已合并为「人事管理员」(HR_ADMIN=4)，不再区分 TEACHER/CHAIRMAN。
  ROLE: {
    ANONYMOUS: 0,
    STUDENT: 1,
    ADMIN: 2,
    SUPER_ADMIN: 3,
    HR_ADMIN: 4,
  },
  ROLE_LEVEL: {
    0: '匿名',
    1: '学生',
    2: '普通管理员',
    3: '超级管理员',
    4: '人事管理员',
  },

  // 集合名
  COLLECTION: {
    users: 'users',
    venues: 'venues',
    time_slots: 'time_slots',
    reservations: 'reservations',
    reservation_records: 'reservation_records',
    blacklist: 'blacklist',
    notices: 'notices',
    notice_read: 'notice_read',
    checkin_records: 'checkin_records',
    operation_logs: 'operation_logs',
    configs: 'configs',
    qrcode_tokens: 'qrcode_tokens',
    banners: 'banners',
    // 学生时段锁：_id = `${openid}_${date}_${slot_key}`，用主键天然唯一兜底「同一学生同一时段只约 1 个场地」，
    // 替代需要控制台手动创建的 uniq_student_slot 唯一索引（SDK 无法自动建索引）。
    student_slot_locks: 'student_slot_locks',
    // 验证码：预约前的图形/算术人机校验（token 一次性、短有效期、绑定 openid）
    captchas: 'captchas',
    // 防刷限流：主键 `openid_route_窗口` 原子抢占，实现「同一用户同一接口在窗口内仅 1 次」的冷却限流
    anti_abuse: 'anti_abuse',
  },

  // 场馆类型与场地数量
  VENUE_TYPES: {
    badminton: { name: '羽毛球场', count: 6, icon: '🏸' },
    pingpong: { name: '乒乓球场', count: 6, icon: '🏓' },
    gym: { name: '健身房', count: 20, icon: '🏋️' },
  },

  // 默认开放时间（前一天 21:00 开放次日）
  DEFAULT_OPEN_TIME: { hour: 21, minute: 0 },

  // 自动拉黑天数（爽约固定 10 天）
  AUTO_BLACK_DAYS: 10,

  // 二维码 token 有效期（毫秒，20 秒）
  QR_TOKEN_EXPIRE: 20000,

  // 签到窗口：场次开始前 N 分钟
  CHECKIN_BEFORE_MIN: 15,

  // 验证码有效期（毫秒，2 分钟）
  CAPTCHA_EXPIRE_MS: 120000,

  // 通用写接口限流：route -> 冷却窗口（毫秒）。同一 openid 同一接口在窗口内仅允许 1 次请求。
  // 用 anti_abuse 集合主键原子抢占实现，避免内存方案在多实例下失效。
  // 注意：仅覆盖「学生侧易被脚本刷」的接口；管理员签到等幂等接口不在此列。
  RATE_LIMIT: {
    'reservation/create': 3000,
    'reservation/cancel': 3000,
    'qrcode/generate': 2000,
    'passport/save_profile': 5000,
  },

  // 初始化超管账号 openid（部署时填写该管理员微信 openid；为空则跳过）
  INIT_ADMIN_OPENID: '',

  // 订阅消息模板 ID（P1，可留空，结构如 { book_success: '', remind: '' }）
  SUBSCRIBE_TPL: {},
};
