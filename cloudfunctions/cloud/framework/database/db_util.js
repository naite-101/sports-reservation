/**
 * 数据库基本操作封装（云开发数据库）
 * 支持：增删改查、分页、条件运算符数组（['>=', val] 等）、and/or、事务、建集合
 */
const config = require('../../config/config.js');

const MAX_RECORD_SIZE = 1000;
const DEFAULT_RECORD_SIZE = 20;

let _cloud = null;

/** 获取（并缓存）云实例 */
function getCloud() {
  if (!_cloud) {
    _cloud = require('wx-server-sdk');
    _cloud.init({ env: config.CLOUD_ID });
  }
  return _cloud;
}

function getDb() {
  return getCloud().database();
}

function getCmd() {
  return getDb().command;
}

/**
 * 新增一条记录（data 可含 _id 指定主键）
 * @returns 主键 _id
 */
async function insert(collectionName, data) {
  const res = await getDb().collection(collectionName).add({ data });
  return res._id;
}

/**
 * 更新记录
 * @param {object|string|number} where 查询条件（字符串/数字视作 _id）
 * @returns 受影响行数
 */
async function edit(collectionName, where, data) {
  const res = await getDb().collection(collectionName).where(fmtWhere(normalizeWhere(where))).update({ data });
  return res.stats.updated;
}

/**
 * 删除记录
 * @returns 删除行数
 */
async function del(collectionName, where) {
  const res = await getDb().collection(collectionName).where(fmtWhere(normalizeWhere(where))).remove();
  return res.stats.removed;
}

/**
 * 统计总数
 */
async function count(collectionName, where) {
  const res = await getDb().collection(collectionName).where(fmtWhere(normalizeWhere(where))).count();
  return res.total;
}

/**
 * 获取单条记录（字符串/数字视作 _id）
 * @returns object|null
 */
async function getOne(collectionName, where, fields = '*', orderBy = {}) {
  let query = getDb().collection(collectionName).where(fmtWhere(normalizeWhere(where)));
  if (orderBy && Object.keys(orderBy).length) {
    query = fmtOrderBy(query, orderBy);
  }
  query = query.limit(1);
  if (fields && fields !== '*') query = query.field(fmtFields(fields));
  const res = await query.get();
  return res && res.data && res.data.length > 0 ? res.data[0] : null;
}

/**
 * 获取全部记录（上限 MAX_RECORD_SIZE）
 */
async function getAll(collectionName, where, fields = '*', orderBy, size = MAX_RECORD_SIZE) {
  let query = getDb().collection(collectionName).where(fmtWhere(normalizeWhere(where)));
  if (orderBy && Object.keys(orderBy).length) {
    query = fmtOrderBy(query, orderBy);
  }
  if (fields && fields !== '*') query = query.field(fmtFields(fields));
  query = query.limit(Math.min(Number(size) || MAX_RECORD_SIZE, MAX_RECORD_SIZE));
  const res = await query.get();
  return res.data || [];
}

/**
 * 分页查询（附带 total/count）
 */
async function getList(collectionName, where, fields = '*', orderBy = {}, page = 1, size = DEFAULT_RECORD_SIZE) {
  page = Number(page) || 1;
  size = Number(size) || DEFAULT_RECORD_SIZE;
  if (size > MAX_RECORD_SIZE) size = MAX_RECORD_SIZE;

  const total = await count(collectionName, where);
  let query = getDb().collection(collectionName).where(fmtWhere(normalizeWhere(where)));
  if (orderBy && Object.keys(orderBy).length) {
    query = fmtOrderBy(query, orderBy);
  }
  if (fields && fields !== '*') query = query.field(fmtFields(fields));
  query = query.skip((page - 1) * size).limit(size);
  const res = await query.get();

  return {
    page: page,
    size: size,
    list: res.data || [],
    total: total,
    count: Math.ceil(total / size),
  };
}

/**
 * 事务封装
 */
async function runTransaction(fn) {
  return await getDb().runTransaction(fn);
}

/**
 * 建集合
 */
async function createCollection(collectionName) {
  return await getDb().createCollection(collectionName);
}

/**
 * 判断集合是否存在
 */
async function isExistCollection(collectionName) {
  try {
    await getOne(collectionName, {});
    return true;
  } catch (e) {
    return false;
  }
}

/** 字符串/数字 where 视作 _id */
function normalizeWhere(where) {
  if (typeof where === 'string' || typeof where === 'number') {
    return { _id: where };
  }
  return where || {};
}

/** fields: "a,b,c" 或对象 */
function fmtFields(fields) {
  if (typeof fields === 'string') {
    const obj = {};
    fields.split(',').forEach((f) => {
      const key = f.trim();
      if (key) obj[key] = true;
    });
    return obj;
  }
  return fields;
}

function fmtOrderBy(query, orderBy) {
  for (const k in orderBy) {
    query = query.orderBy(k, String(orderBy[k]).toLowerCase());
  }
  return query;
}

/**
 * 条件处理：
 * - 简单对象：{ field: value }
 * - 运算符数组：{ field: ['>=', 3] } 或 { field: [['>=', 1], ['<=', 10]] }
 * - and/or：{ and: {...}, or: [{...},{...}], ...other }
 */
function fmtWhere(where) {
  if (!where) return {};
  const cmd = getCmd();

  if (where.and !== undefined || where.or !== undefined) {
    const conds = [];
    if (where.and !== undefined) conds.push(fmtWhere(where.and));
    if (where.or !== undefined) conds.push(cmd.or(fmtWhere(where.or)));
    const extra = {};
    for (const k in where) {
      if (k === 'and' || k === 'or') continue;
      extra[k] = fmtValue(where[k]);
    }
    if (Object.keys(extra).length) conds.push(extra);
    return cmd.and(conds);
  }

  if (Array.isArray(where)) {
    return where.map((item) => fmtWhere(item));
  }

  const out = {};
  for (const k in where) {
    out[k] = fmtValue(where[k]);
  }
  return out;
}

function fmtValue(val) {
  const cmd = getCmd();
  if (!Array.isArray(val)) return val;
  if (val.length === 0) return val;

  const is2d = Array.isArray(val[0]);
  if (!is2d) {
    return fmtOp(val);
  }
  // 二维数组：多条件组合（and）
  let expr = null;
  for (const item of val) {
    const e = fmtOp(item);
    expr = expr ? expr.and(e) : e;
  }
  return expr;
}

function fmtOp(arr) {
  const cmd = getCmd();
  const op = String(arr[0]).toLowerCase().trim();
  const val = arr[1];
  switch (op) {
    case '=':
      return cmd.eq(val);
    case '!=':
    case '<>':
      return cmd.neq(val);
    case '<':
      return cmd.lt(val);
    case '<=':
      return cmd.lte(val);
    case '>':
      return cmd.gt(val);
    case '>=':
      return cmd.gte(val);
    case 'in':
      return cmd.in(Array.isArray(val) ? val : String(val).split(','));
    case 'like':
      return getDb().RegExp({ regexp: String(val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
    case 'between':
      return cmd.and(cmd.gte(arr[1]), cmd.lte(arr[2]));
    default:
      return val;
  }
}

module.exports = {
  getCloud,
  getDb,
  getCmd,
  insert,
  edit,
  del,
  count,
  getOne,
  getAll,
  getList,
  runTransaction,
  createCollection,
  isExistCollection,
  MAX_RECORD_SIZE,
  DEFAULT_RECORD_SIZE,
};
