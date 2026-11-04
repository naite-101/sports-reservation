/**
 * 小程序端通用工具（设备本地时间，东八区）
 */
function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function formatDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function addDays(dateStr, n) {
  const p = dateStr.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  d.setDate(d.getDate() + n);
  return formatDate(d);
}

function today() {
  return formatDate(new Date());
}

function tomorrow() {
  return addDays(today(), 1);
}

function parseSlotKey(slotKey) {
  const m = /^(\d{2})(\d{2})_(\d{2})(\d{2})$/.exec(slotKey);
  if (!m) return null;
  const sh = Number(m[1]);
  const sm = Number(m[2]);
  const eh = Number(m[3]);
  const em = Number(m[4]);
  return {
    start_min: sh * 60 + sm,
    end_min: eh * 60 + em,
    start_time: pad2(sh) + ':' + pad2(sm),
    end_time: pad2(eh) + ':' + pad2(em),
  };
}

function timestamp2Time(ms, fmt = 'Y-M-D h:m:s') {
  const d = new Date(ms);
  const map = {
    Y: d.getFullYear(),
    M: pad2(d.getMonth() + 1),
    D: pad2(d.getDate()),
    h: pad2(d.getHours()),
    m: pad2(d.getMinutes()),
    s: pad2(d.getSeconds()),
  };
  return fmt.replace(/[YMDhms]/g, (c) => map[c]);
}

/** 毫秒时间戳 -> 中文日期 "YYYY年M月D日"（不补零） */
function timestamp2TimeCn(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

function statusText(status) {
  const map = {
    pending: '待签到',
    checked_in: '已签到',
    cancelled: '已取消',
    expired: '未签到',
  };
  return map[status] || status;
}

module.exports = {
  pad2: pad2,
  formatDate: formatDate,
  addDays: addDays,
  today: today,
  tomorrow: tomorrow,
  parseSlotKey: parseSlotKey,
  timestamp2Time: timestamp2Time,
  timestamp2TimeCn: timestamp2TimeCn,
  statusText: statusText,
};
