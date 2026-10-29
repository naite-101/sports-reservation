/**
 * 路由表：route -> { controller, action, role }
 * role 为最小所需角色等级（数值越大权限越高）。
 * job/* 不走鉴权（由定时触发器或 JOB_SECRET 触发）；init/run 在 application 中特判。
 */
module.exports = {
  // ---------- passport（登录/信息） ----------
  'passport/login': { controller: 'passport_controller', action: 'login', role: 0 },
  'passport/save_profile': { controller: 'passport_controller', action: 'saveProfile', role: 1 },

  // ---------- 学生预约 / 场馆 / 场次 ----------
  'venue/list': { controller: 'venue_controller', action: 'list', role: 1 },
  'slot/list': { controller: 'venue_controller', action: 'slotList', role: 1 },
  'reservation/status': { controller: 'reservation_controller', action: 'status', role: 1 },
  'reservation/create': { controller: 'reservation_controller', action: 'create', role: 1 },
  'reservation/cancel': { controller: 'reservation_controller', action: 'cancel', role: 1 },

  // ---------- 我的 / 记录 / 二维码 ----------
  'my/reservations': { controller: 'my_controller', action: 'reservations', role: 1 },
  'my/records': { controller: 'my_controller', action: 'records', role: 1 },
  'my/profile': { controller: 'my_controller', action: 'profile', role: 1 },
  'qrcode/generate': { controller: 'qrcode_controller', action: 'generate', role: 1 },
  'qrcode/valid_booking': { controller: 'qrcode_controller', action: 'validBooking', role: 1 },

  // ---------- 公告（匿名可看） ----------
  'notice/latest': { controller: 'notice_controller', action: 'latest', role: 0 },
  'notice/list': { controller: 'notice_controller', action: 'list', role: 0 },
  'notice/detail': { controller: 'notice_controller', action: 'detail', role: 0 },

  // ---------- 公告管理（架构路由表未列，T04 要求，补充为 admin/notice_*） ----------
  'admin/notice_list': { controller: 'notice_controller', action: 'adminList', role: 2 },
  'admin/notice_add': { controller: 'notice_controller', action: 'add', role: 2 },
  'admin/notice_edit': { controller: 'notice_controller', action: 'edit', role: 2 },
  'admin/notice_delete': { controller: 'notice_controller', action: 'remove', role: 2 },

  // ---------- admin 签到 / 签到记录 ----------
  'admin/scan': { controller: 'admin_controller', action: 'scan', role: 2 },
  'admin/checkin': { controller: 'admin_controller', action: 'checkin', role: 2 },
  'admin/checkin_records': { controller: 'admin_controller', action: 'checkinRecords', role: 2 },

  // ---------- 黑名单 ----------
  'blacklist/list': { controller: 'blacklist_controller', action: 'list', role: 2 },
  'blacklist/add': { controller: 'blacklist_controller', action: 'add', role: 2 },
  'blacklist/release': { controller: 'blacklist_controller', action: 'release', role: 3 },

  // ---------- 场地闭馆 / 系统日志 ----------
  'venue/close': { controller: 'venue_controller', action: 'close', role: 3 },
  'venue/close_list': { controller: 'venue_controller', action: 'closeList', role: 3 },
  'log/list': { controller: 'log_controller', action: 'list', role: 3 },

  // ---------- 人事（老师/主席专属；任命类接口超管也可进入） ----------
  'hr/admin_list': { controller: 'hr_controller', action: 'adminList', role: 3 },
  'hr/admin_add': { controller: 'hr_controller', action: 'adminAdd', role: 3 },
  'hr/admin_remove': { controller: 'hr_controller', action: 'adminRemove', role: 4 },
  'hr/admin_assign': { controller: 'hr_controller', action: 'adminAssign', role: 3 },
  'hr/student_list': { controller: 'hr_controller', action: 'studentList', role: 4 },
  'hr/student_detail': { controller: 'hr_controller', action: 'studentDetail', role: 4 },
  'hr/student_edit': { controller: 'hr_controller', action: 'studentEdit', role: 4 },

  // ---------- 配置 / 消息 ----------
  'config/get': { controller: 'config_controller', action: 'get', role: 0 },
  'config/set': { controller: 'config_controller', action: 'set', role: 3 },
  'config/activity_pic': { controller: 'config_controller', action: 'activityPic', role: 3 },
  'message/subscribe': { controller: 'message_controller', action: 'subscribe', role: 1 },

  // ---------- 定时任务（由触发器/密钥触发，不走鉴权） ----------
  'job/expire': { controller: 'job_controller', action: 'expire', role: 0 },
  'job/notify': { controller: 'job_controller', action: 'notify', role: 0 },

  // ---------- 云端冒烟测试（受 job_secret 保护，application 中特判） ----------
  'smoke/run': { controller: 'smoke_controller', action: 'run', role: 0 },
};
