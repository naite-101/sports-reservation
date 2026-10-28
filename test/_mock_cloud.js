/**
 * 微信云开发（wx-server-sdk）内存 mock
 * 目的：在不连接真实云环境的前提下，直接加载并运行 cloudfunctions/cloud 下的真实业务代码。
 * 覆盖：collection/add/doc/get/update/remove、where 链式查询、count、orderBy/limit/skip/field、
 *       command(eq/neq/gt/gte/lt/lte/in/and/or)、RegExp、runTransaction(带快照回滚)、getWXContext。
 *
 * 由 test/run.js 在所有用例加载前调用 install()，把 require('wx-server-sdk') 指向本 mock。
 *
 * 局限（务必知晓）：单进程内存实现，无法复现真实数据库的并发隔离与唯一索引底层行为；
 * 唯一索引通过 setUniqueIndexes 显式模拟，并发场景需自行构造。
 */

const Module = require('module');

const store = new Map(); // collection -> Map(_id -> doc)
let autoId = 0;
let ctx = { OPENID: '' };
let uniqueIndexes = []; // [{ coll, fields: ['a','b'] }]

function clone(o) {
  return o === undefined ? o : JSON.parse(JSON.stringify(o));
}

function coll(name) {
  if (!store.has(name)) store.set(name, new Map());
  return store.get(name);
}

/* ---------------- command 模拟 ---------------- */
const OP = (op, v) => ({ __op: op, v });
const command = {
  eq: (v) => OP('eq', v),
  neq: (v) => OP('neq', v),
  gt: (v) => OP('gt', v),
  gte: (v) => OP('gte', v),
  lt: (v) => OP('lt', v),
  lte: (v) => OP('lte', v),
  in: (v) => OP('in', v),
  and: (arr) => ({ __and: Array.isArray(arr) ? arr : [arr] }),
  or: (arr) => ({ __or: Array.isArray(arr) ? arr : [arr] }),
};

function isOp(v) {
  return v && typeof v === 'object' && (v.__op || v.__and || v.__or);
}

function cmp(op, a, b) {
  switch (op) {
    case 'eq': return a === b;
    case 'neq': return a !== b;
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    case 'in': return (b || []).indexOf(a) >= 0;
    default: return false;
  }
}

function matchValue(val, cond) {
  if (cond instanceof RegExp) return typeof val === 'string' && cond.test(val);
  if (isOp(cond)) {
    if (cond.__and) return cond.__and.every((c) => matchValue(val, c));
    if (cond.__or) return cond.__or.some((c) => matchValue(val, c));
    return cmp(cond.__op, val, cond.v);
  }
  if (cond && typeof cond === 'object') {
    // 嵌套对象（如 detail.xxx）暂不深比较，按引用相等处理
    return JSON.stringify(val) === JSON.stringify(cond);
  }
  return val === cond;
}

function match(doc, query) {
  if (!query) return true;
  if (isOp(query)) {
    if (query.__and) return query.__and.every((q) => match(doc, q));
    if (query.__or) return query.__or.some((q) => match(doc, q));
  }
  for (const k of Object.keys(query)) {
    if (!matchValue(doc[k], query[k])) return false;
  }
  return true;
}

/* ---------------- 查询对象 ---------------- */
function makeQuery(collName, query) {
  const state = { query: query || {}, order: [], skipN: 0, limitN: 0, fields: null };

  const api = {
    where(q) {
      state.query = q || {};
      return api;
    },
    orderBy(k, dir) {
      state.order.push([k, String(dir).toLowerCase() === 'desc' ? -1 : 1]);
      return api;
    },
    skip(n) {
      state.skipN = n;
      return api;
    },
    limit(n) {
      state.limitN = n;
      return api;
    },
    field(f) {
      state.fields = f;
      return api;
    },
    _rows() {
      let rows = Array.from(coll(collName).values()).filter((d) => match(d, state.query));
      if (state.order.length) {
        rows.sort((a, b) => {
          for (const [k, dir] of state.order) {
            if (a[k] === b[k]) continue;
            return (a[k] > b[k] ? 1 : -1) * dir;
          }
          return 0;
        });
      }
      if (state.skipN) rows = rows.slice(state.skipN);
      if (state.limitN) rows = rows.slice(0, state.limitN);
      if (state.fields && typeof state.fields === 'object') {
        rows = rows.map((d) => {
          const out = { _id: d._id };
          for (const k of Object.keys(state.fields)) {
            if (state.fields[k]) out[k] = d[k];
          }
          return out;
        });
      }
      return rows.map(clone);
    },
    async get() {
      return { data: api._rows() };
    },
    async count() {
      return { total: Array.from(coll(collName).values()).filter((d) => match(d, state.query)).length };
    },
    async update({ data }) {
      const rows = Array.from(coll(collName).values()).filter((d) => match(d, state.query));
      for (const d of rows) Object.assign(d, clone(data));
      return { stats: { updated: rows.length } };
    },
    async remove() {
      const c = coll(collName);
      const ids = Array.from(c.values()).filter((d) => match(d, state.query)).map((d) => d._id);
      ids.forEach((id) => c.delete(id));
      return { stats: { removed: ids.length } };
    },
  };
  return api;
}

function dupError(msg) {
  const e = new Error(msg);
  e.errMsg = 'database.add:fail ' + msg;
  return e;
}

function checkUnique(collName, doc) {
  for (const idx of uniqueIndexes) {
    if (idx.coll !== collName) continue;
    const hit = Array.from(coll(collName).values()).some(
      (d) => d._id !== doc._id && idx.fields.every((f) => d[f] === doc[f])
    );
    if (hit) {
      throw dupError('duplicate key error: index ' + (idx.name || idx.fields.join('_')) + ' already exists');
    }
  }
}

function collection(collName) {
  const api = {
    async add({ data }) {
      const c = coll(collName);
      const doc = clone(data);
      if (doc._id === undefined) {
        autoId += 1;
        doc._id = 'auto_' + autoId;
      } else if (c.has(doc._id)) {
        throw dupError('document with _id "' + doc._id + '" already exists (duplicate)');
      }
      checkUnique(collName, doc);
      c.set(doc._id, doc);
      return { _id: doc._id };
    },
    where(q) {
      return makeQuery(collName, q);
    },
    doc(id) {
      return {
        async get() {
          const d = coll(collName).get(id);
          if (!d) {
            const e = new Error('document.get:fail document does not exist');
            e.errMsg = 'document.get:fail document does not exist';
            throw e;
          }
          return { data: clone(d) };
        },
        async update({ data }) {
          const d = coll(collName).get(id);
          if (!d) {
            const e = new Error('document.update:fail document does not exist');
            e.errMsg = 'document.update:fail document does not exist';
            throw e;
          }
          Object.assign(d, clone(data));
          return { stats: { updated: 1 } };
        },
        async remove() {
          const c = coll(collName);
          const existed = c.delete(id);
          return { stats: { removed: existed ? 1 : 0 } };
        },
      };
    },
    async count() {
      return { total: coll(collName).size };
    },
  };
  // 兼容 collection().where(...) 直接调用（部分代码走 getDb().collection(x).where）
  api.where = (q) => makeQuery(collName, q);
  return api;
}

function database() {
  return {
    collection,
    command,
    RegExp: ({ regexp, options }) => new RegExp(regexp, options || ''),
    async createCollection(name) {
      coll(name);
      return { errMsg: 'createCollection:ok' };
    },
    async runTransaction(fn) {
      const backup = new Map();
      for (const [k, v] of store) backup.set(k, new Map(Array.from(v).map(([id, d]) => [id, clone(d)])));
      const tx = {
        collection: (name) => ({
          doc: (id) => collection(name).doc(id),
          add: (arg) => collection(name).add(arg),
        }),
      };
      try {
        return await fn(tx);
      } catch (e) {
        store.clear();
        for (const [k, v] of backup) store.set(k, v);
        throw e;
      }
    },
  };
}

const sdk = {
  init() {},
  database,
  getWXContext() {
    return { OPENID: ctx.OPENID, APPID: 'wxtest', UNIONID: '' };
  },
  openapi: {
    subscribeMessage: {
      async send() {
        return { errCode: 0 };
      },
    },
  },
};

/* ---------------- 控制接口 ---------------- */
function reset() {
  store.clear();
  uniqueIndexes = [];
  autoId = 0;
  ctx = { OPENID: '' };
}

let installed = false;
/** 把 require('wx-server-sdk') 重定向到内存 mock（幂等） */
function install() {
  if (installed) return sdk;
  installed = true;
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'wx-server-sdk') return sdk;
    return origLoad.apply(this, arguments);
  };
  return sdk;
}

module.exports = {
  sdk,
  install,
  reset,
  setOpenId(id) {
    ctx = { OPENID: id };
  },
  setUniqueIndexes(list) {
    uniqueIndexes = list || [];
  },
  seed(collName, doc) {
    const c = coll(collName);
    const d = clone(doc);
    if (d._id === undefined) {
      autoId += 1;
      d._id = 'seed_' + autoId;
    }
    c.set(d._id, d);
    return d._id;
  },
  dump(collName) {
    return Array.from(coll(collName).values()).map(clone);
  },
  size(collName) {
    return coll(collName).size;
  },
};
