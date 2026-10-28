/**
 * 初始化脚本：建集合 + 写入场馆32/场次6/默认配置 + 超管账号
 * 调用方式：云函数测试（云端）传入 { route: 'init/run', job_secret: '<JOB_SECRET>' }
 */
const config = require('../../config/config.js');
const dbUtil = require('../../framework/database/db_util.js');
const timeUtil = require('../../framework/utils/time_util.js');
const VenueModel = require('../model/venue_model.js');
const TimeSlotModel = require('../model/time_slot_model.js');
const ConfigModel = require('../model/config_model.js');
const UserModel = require('../model/user_model.js');

/** 场次模板（与 PRD/架构一致） */
const TIME_SLOTS = [
  { slot_key: '1300_1410', start_time: '13:00', end_time: '14:10', start_min: 780, end_min: 850, day_type: 'weekend', sort: 1 },
  { slot_key: '1420_1530', start_time: '14:20', end_time: '15:30', start_min: 860, end_min: 930, day_type: 'weekend', sort: 2 },
  { slot_key: '1540_1650', start_time: '15:40', end_time: '16:50', start_min: 940, end_min: 1010, day_type: 'weekend', sort: 3 },
  { slot_key: '1700_1810', start_time: '17:00', end_time: '18:10', start_min: 1020, end_min: 1090, day_type: 'weekend', sort: 4 },
  { slot_key: '1820_1930', start_time: '18:20', end_time: '19:30', start_min: 1100, end_min: 1170, day_type: 'all', sort: 5 },
  { slot_key: '1940_2050', start_time: '19:40', end_time: '20:50', start_min: 1180, end_min: 1250, day_type: 'all', sort: 6 },
];

async function createCollections() {
  const names = Object.values(config.COLLECTION);
  const created = [];
  for (const name of names) {
    const exist = await dbUtil.isExistCollection(name);
    if (!exist) {
      try {
        await dbUtil.createCollection(name);
        created.push(name);
      } catch (e) {
        console.error('建集合失败：' + name, e);
      }
    }
  }
  return created;
}

async function initVenues() {
  const count = await VenueModel.count({});
  if (count > 0) return { skipped: true, count: count };

  const now = timeUtil.now();
  let total = 0;
  for (const type in config.VENUE_TYPES) {
    const info = config.VENUE_TYPES[type];
    for (let i = 1; i <= info.count; i++) {
      const venueKey = type + '#' + i;
      await VenueModel.insert({
        _id: venueKey,
        venue_key: venueKey,
        venue_type: type,
        venue_type_name: info.name,
        court_no: i,
        closed: false,
        closed_until: 0,
        update_time: now,
      });
      total++;
    }
  }
  return { skipped: false, count: total };
}

async function initTimeSlots() {
  const count = await TimeSlotModel.count({});
  if (count > 0) return { skipped: true, count: count };

  for (const s of TIME_SLOTS) {
    await TimeSlotModel.insert({
      _id: s.slot_key,
      slot_key: s.slot_key,
      start_time: s.start_time,
      end_time: s.end_time,
      start_min: s.start_min,
      end_min: s.end_min,
      day_type: s.day_type,
      sort: s.sort,
    });
  }
  return { skipped: false, count: TIME_SLOTS.length };
}

async function initConfigs() {
  const now = timeUtil.now();
  const items = [
    { key: 'open_time', value: config.DEFAULT_OPEN_TIME },
    { key: 'activity_pic', value: '' },
    { key: 'subscribe_tpl', value: config.SUBSCRIBE_TPL },
  ];
  const done = [];
  for (const it of items) {
    const exist = await ConfigModel.getOne(it.key);
    if (!exist) {
      await ConfigModel.insert({ _id: it.key, key: it.key, value: it.value, update_time: now });
      done.push(it.key);
    }
  }
  return done;
}

async function initAdmin() {
  if (!config.INIT_ADMIN_OPENID) {
    return { skipped: true, msg: '未配置 INIT_ADMIN_OPENID，跳过超管创建' };
  }
  const openid = config.INIT_ADMIN_OPENID;
  const exist = await UserModel.getOne(openid);
  const now = timeUtil.now();
  if (exist) {
    // 提升为超级管理员（仅在当前是学生时）
    if ((exist.role || 0) < config.ROLE.SUPER_ADMIN) {
      await UserModel.edit(openid, { role: config.ROLE.SUPER_ADMIN, update_time: now });
    }
    return { openid: openid, updated: true };
  }
  await UserModel.insert({
    _id: openid,
    openid: openid,
    role: config.ROLE.SUPER_ADMIN,
    name: '超级管理员',
    student_no: '',
    phone: '',
    college: '',
    info_completed: true,
    status: 1,
    black_until: 0,
    create_time: now,
    update_time: now,
  });
  return { openid: openid, created: true };
}

/**
 * 创建索引（关键：uniq_student_slot 保证「同一学生同一时间窗跨场馆只约 1 个」）
 * 云开发数据库 createIndex 在索引已存在时会报错，这里把「已存在」视为成功。
 */
async function createIndexes() {
  const collName = config.COLLECTION.reservations;
  const indexes = [
    {
      name: 'uniq_student_slot',
      unique: true,
      keys: [
        { student_openid: 'asc' },
        { date: 'asc' },
        { slot_key: 'asc' },
      ],
    },
  ];
  const coll = dbUtil.getDb().collection(collName);
  // wx-server-sdk 及其依赖（@cloudbase/node-sdk、@cloudbase/database）都不提供 createIndex，
  // 实际必然走下面的降级分支，索引需在控制台手动创建。
  if (typeof coll.createIndex !== 'function') {
    console.warn('[init] 当前 wx-server-sdk 不支持 createIndex，请按 README 第 5 步在控制台手动创建唯一索引 uniq_student_slot（否则防重复仅依赖应用层校验，存在并发竞态）');
    return ['uniq_student_slot(manual-required)'];
  }
  const created = [];
  for (const idx of indexes) {
    try {
      await coll.createIndex(idx);
      created.push(idx.name);
    } catch (e) {
      const m = String((e && (e.errMsg || e.message)) || '');
      // 索引已存在视为成功（重跑 init 幂等）
      if (m.indexOf('exist') >= 0 || m.indexOf('already') >= 0) {
        created.push(idx.name + '(exists)');
      } else {
        console.error('建索引失败：' + idx.name, e);
        throw e;
      }
    }
  }
  return created;
}

async function initAll() {
  const createdCollections = await createCollections();
  const indexes = await createIndexes();
  const venues = await initVenues();
  const slots = await initTimeSlots();
  const configs = await initConfigs();
  const admin = await initAdmin();

  return {
    created_collections: createdCollections,
    indexes: indexes,
    venues: venues,
    time_slots: slots,
    configs: configs,
    admin: admin,
    note: 'uniq_student_slot 需在云开发控制台手动创建（当前 wx-server-sdk 不提供 createIndex），见 README 第 5 步',
  };
}

module.exports = {
  initAll,
  initVenues,
  initTimeSlots,
  initConfigs,
  initAdmin,
  TIME_SLOTS,
};
