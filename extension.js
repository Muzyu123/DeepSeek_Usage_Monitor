/*
 * DeepSeek Usage Monitor — VSCode Extension
 * 基于 linnin233 的 MIT 项目：https://github.com/linnin233/deepseek-usage-vscode 进行了前端重构、后端修补和部分功能自定义
 *
 * 数据源：
 *   余额  → api.deepseek.com/user/balance (API Key sk-...)
 *   用量  → platform.deepseek.com/api/v0/usage/* (Session Token + Cookie)
 *
 * 面板视觉元素复刻自deepseek官方 platform.deepseek.com/usage（用量信息页）：
 *   包含充值余额 / 今日消费 / 月份选择 / 每月消费金额·API请求次数·Tokens / 按模型堆叠的每日消费柱状图
 */

const vscode = require('vscode');
const https = require('https');
const http = require('http');
const tls = require('tls');

// 系统 keyring 缺失时（如 Linux 无 org.freedesktop.secrets）会造成进程阻塞
// 所以 secrets 读取一律带超时 + 内存缓存
const SECRETS_KEY = 'deepseek-usage-monitor.apiKey';
const PRESET_STATE_KEY = 'deepseekUsage.rangePreset';   // 面板时间窗口的持久化键
const SECRETS_TIMEOUT_MS = 2000; // 等待 secrets 响应超时的阈值，超时后降级为内存缓存并报错，API Key 只在本次会话有效

// ============================================================
//  Constants & i18n
// ============================================================

// 平台按 UTC+8 口径返回日期（请求头 x-client-timezone-offset: 28800）
const TZ8_OFFSET_MS = 8 * 3600 * 1000;

const L10N = {
  en: {
    title: 'DeepSeek Usage',
    usageTitle: 'Usage',
    tzNote: 'All dates are in GMT+8. Data may be delayed up to 5 minutes.',
    toppedUpBalance: 'Top-up Balance',
    todayCost: "Today's Cost",
    costAmount: 'Cost',
    costCny: 'Cost (CNY)',
    apiRequests: 'API requests',
    tokens: 'Tokens',
    rangeLabel: 'Time range',
    rangeToday: 'Today',
    rangeYesterday: 'Yesterday',
    rangeLast7: 'Last 7 days',
    rangeLast30: 'Last 30 days',
    rangeThisMonth: 'This month',
    rangeLastMonth: 'Last month',
    noDataRange: 'No cost data in this period',
    updatedAtLabel: 'Updated {0}',
    loading: 'Loading...', refresh: 'Refresh',
    settings: '⚙ Settings', setApiKey: 'Set API Key',
    sbTodayCost: 'Today', sbMonthCost: 'Month', sbBalance: 'Balance', sbTodayTokens: 'Today',
    noSessionToken: 'Configure Session Token & Cookie',
    errNoApiKey: 'Set API Key',
    loadFailed: 'Failed to load usage data',
    sessionExpired: 'Session expired — update your Session Token',
    balanceInsufficient: 'Insufficient balance',
    keySessionOnly: 'Session only (system keyring unavailable)',
    enterApiKey: 'Enter DeepSeek API Key',
    errEmptyKey: 'Input is empty: enter an API key (format sk-xxx)',
    errKeyFormat: 'Invalid format: the API key must start with sk- (format sk-xxx)',
    keySaved: 'API Key saved',
    keySavedSession: 'API Key saved (valid only for this time)',
    keyPersistFailed: 'API key is active for this session only: the system keyring is unavailable, re-enter it after restart',
    keyringUnavailable: 'System keyring unavailable ({0}): re-enter the API key; it will only be valid for this session and must be re-entered after a restart',
    keyReadTimeout: 'read timed out after {0}ms',
    keyReadFailed: 'read failed',
    keyNotPersisted: 'the API key saved earlier could not be read',
    errApiKey401: 'API key invalid (401)',
    errHttp: 'Request failed: HTTP {0}',
    errRateLimited: 'Too many requests — try again later',
    errBadResponse: 'Unexpected response format',
    errTimeout: 'Request timed out',
    errTlsTimeout: 'TLS handshake timed out',
    errProxyTimeout: 'Proxy connection timed out',
    errNetwork: 'Network error: {0}',
    errPlatform: 'Platform error: {0}',
    errScopeBalance: 'Balance',
    errScopeUsage: 'Usage',
    errEntry: '{0}: {1}',
    genericError: 'DeepSeek Usage error: {0}',
    clickDetails: 'Click for details',
    granted: 'Granted',
  },
  'zh-cn': {
    title: 'DeepSeek Usage',
    usageTitle: '用量信息',
    tzNote: '所有日期均按 GMT+8 时间显示，数据可能有 5 分钟延迟。',
    toppedUpBalance: '充值余额',
    todayCost: '今日消费',
    costAmount: '消费金额',
    costCny: '消费金额（CNY）',
    apiRequests: 'API 请求次数',
    tokens: 'Tokens',
    rangeLabel: '时间范围',
    rangeToday: '今天',
    rangeYesterday: '昨天',
    rangeLast7: '近7天',
    rangeLast30: '近30天',
    rangeThisMonth: '本月',
    rangeLastMonth: '上月',
    noDataRange: '该时间段暂无消费数据',
    updatedAtLabel: '数据更新时间 {0}',
    loading: '加载中...', refresh: '刷新',
    settings: '⚙ 设置', setApiKey: '设置 API Key',
    sbTodayCost: '本日消费', sbMonthCost: '本月消费', sbBalance: '账户余额', sbTodayTokens: '本日消耗',
    noSessionToken: '请在设置中配置 Session Token 和 Cookie',
    errNoApiKey: '请设置 API Key',
    loadFailed: '加载用量数据失败',
    sessionExpired: '会话已过期，请更新 Session Token',
    balanceInsufficient: '余额不足，请充值',
    keySessionOnly: '仅本次会话有效（系统密钥环不可用）',
    enterApiKey: '输入 DeepSeek API Key',
    errEmptyKey: '输入为空：请输入 API Key（格式 sk-xxx）',
    errKeyFormat: '格式错误：API Key 应以 sk- 开头（格式 sk-xxx）',
    keySaved: 'API Key 已保存',
    keySavedSession: 'API Key 已保存（仅本次会话有效）',
    keyPersistFailed: 'API Key 已生效（本次会话有效：系统密钥环不可用，重启后需重新输入）',
    keyringUnavailable: '系统密钥环不可用（{0}），请重新输入 API Key；该 Key 仅本次会话有效，重启后需重新输入',
    keyReadTimeout: '读取超时 >{0}ms',
    keyReadFailed: '读取失败',
    keyNotPersisted: '未读取到上次保存的 API Key',
    errApiKey401: 'API Key 无效 (401)',
    errHttp: '请求失败：HTTP {0}',
    errRateLimited: '请求过于频繁，请稍后重试',
    errBadResponse: '响应格式异常',
    errTimeout: '请求超时',
    errTlsTimeout: 'TLS 握手超时',
    errProxyTimeout: '代理连接超时',
    errNetwork: '网络错误：{0}',
    errPlatform: '平台错误：{0}',
    errScopeBalance: '余额',
    errScopeUsage: '用量',
    errEntry: '{0}：{1}',
    genericError: 'DeepSeek Usage 出错：{0}',
    clickDetails: '点击查看详情',
    granted: '赠送',
  },
};

function t() {
  const lang = vscode.workspace.getConfiguration('deepseek-usage-monitor').get('language', 'zh-cn');
  return L10N[lang] || L10N['zh-cn'];
}

// 带占位符的文案：tf('key', a, b) 把 {0}、{1} 替换成 a、b；随 language 设置切换
function tf(key, ...args) {
  let s = t()[key] || key;
  args.forEach((a, i) => { s = s.replace('{' + i + '}', String(a == null ? '' : a)); });
  return s;
}

// 把内部异常原文映射为面向用户的本地化文案；未识别的原文原样返回，避免吞掉诊断信息
function humanizeError(msg) {
  const m = String(msg == null ? '' : msg);
  const L = t();
  if (m === 'API Key invalid (401)') return L.errApiKey401;
  if (/^Session expired\b/.test(m)) return L.sessionExpired;   // 含平台 40002/40003 的 (Missing/Invalid Token)
  if (m === 'Rate limited') return L.errRateLimited;
  if (/^HTTP \d+$/.test(m)) return tf('errHttp', m.slice(5));
  if (/^Invalid response\b/.test(m)) return L.errBadResponse;
  if (m === 'Timeout') return L.errTimeout;
  if (m === 'TLS timeout') return L.errTlsTimeout;
  if (m === 'Proxy timeout') return L.errProxyTimeout;
  if (/\(code \d+\)$/.test(m)) return tf('errPlatform', m);   // 平台返回的其它业务错误（msg 多为平台自带文案）
  if (/^(getaddrinfo|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|EPROTO|socket hang up|Client network socket)/.test(m)) {
    return tf('errNetwork', m);
  }
  return m;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function tz8Now() { return new Date(Date.now() + TZ8_OFFSET_MS); }

function fmtCost(n) { return (parseFloat(n) || 0).toFixed(2); }

// ============================================================
//  HTTP Client — supports optional HTTP CONNECT proxy
// ============================================================

function httpsRequest({ hostname, path, method, headers, proxy }) {
  return new Promise((resolve, reject) => {
    if (!proxy) {
      const req = https.request({ hostname, path, method, headers, timeout: 15000 }, (res) => {
        let body = ''; res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, data: body }));
      });
      req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); }); req.end(); return;
    }
    // HTTP CONNECT tunnel
    const pu = new URL(proxy);
    const preq = http.request({ host: pu.hostname, port: pu.port || 8080, method: 'CONNECT', path: `${hostname}:443`, timeout: 10000 });
    preq.on('connect', (_r, s) => {
      const ts = tls.connect({ socket: s, servername: hostname, rejectUnauthorized: false }, () => {
        ts.write([`${method} ${path} HTTP/1.1`, `Host: ${hostname}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), 'Connection: close', '', ''].join('\r\n'));
        let raw = '', hd = false, sc = 0;
        ts.on('data', (c) => { raw += c.toString(); if (!hd) { const i = raw.indexOf('\r\n\r\n'); if (i !== -1) { sc = parseInt((raw.substring(0, i).match(/HTTP\/\d\.\d (\d+)/) || ['', '0'])[1]); raw = raw.substring(i + 4); hd = true; } } });
        ts.on('end', () => resolve({ status: sc, data: raw }));
        ts.on('error', reject); ts.setTimeout(15000, () => { ts.destroy(); reject(new Error('TLS timeout')); });
      }); ts.on('error', reject);
    });
    preq.on('error', reject); preq.on('timeout', () => { preq.destroy(); reject(new Error('Proxy timeout')); }); preq.end();
  });
}

// ============================================================
//  API Functions
// ============================================================

async function fetchBalance(apiKey) {
  const { status, data } = await httpsRequest({ hostname: 'api.deepseek.com', path: '/user/balance', method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } });
  if (status === 401) throw new Error('API Key invalid (401)'); if (status !== 200) throw new Error(`HTTP ${status}`); return JSON.parse(data);
}

// 平台私有接口。注意：认证失败等错误返回的是 HTTP 200 + body 里的 code
// 实测未带 token 时：{"code":40002,"msg":"Missing Token"}，所以必须额外判 body.code，
// 否则 session 过期会被当成"成功但零消费"，页面静默显示 ¥0.00
const PLATFORM_ERROR_CODES = { 40002: 'Session expired (Missing Token)', 40003: 'Session expired (Invalid Token)' };

async function fetchPlatformApi(sessionToken, cookie, proxy, path) {
  const { status, data } = await httpsRequest({
    hostname: 'platform.deepseek.com', path, method: 'GET',
    headers: { Authorization: `Bearer ${sessionToken}`, Cookie: cookie || '', 'x-client-locale': 'zh_CN', 'x-client-platform': 'web', 'x-client-timezone-offset': '28800', 'x-client-version': '1.0.0', Referer: 'https://platform.deepseek.com/usage', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36' },
    proxy: proxy || undefined,
  });
  if (status === 401) throw new Error('Session expired');
  if (status === 429) throw new Error('Rate limited');
  if (status !== 200) throw new Error(`HTTP ${status}`);
  let json;
  try { json = JSON.parse(data); }
  catch { throw new Error(`Invalid response (HTTP 200 but not JSON)`); }
  if (json && typeof json.code === 'number' && json.code !== 0) {
    throw new Error(PLATFORM_ERROR_CODES[json.code] || `${json.msg || 'Platform error'} (code ${json.code})`);
  }
  return json;
}

// 区间接口：显式 tz=28800，平台按 GMT+8 分桶返回原始小时桶。
// 月接口只有请求头 x-client-timezone-offset，平台并不据此分桶（实际按 UTC），
// 会让 GMT+8 00:00–08:00 的消费落到前一天 —— 所以优先走区间接口，月接口仅作兜底。
function tz8DayStartSec(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / 1000) - TZ8_OFFSET_MS / 1000;
}

// ============================================================
//  Time Range Presets —— 面板时间窗口
// ============================================================

// 下拉顺序 = 数组顺序；id 会写进 globalState，改动等于让用户已选的存档失效
const RANGE_PRESET_DEFS = [
  { id: 'today', key: 'rangeToday', granularity: 'hour' },
  { id: 'yesterday', key: 'rangeYesterday', granularity: 'hour' },
  { id: 'last7', key: 'rangeLast7', granularity: 'day' },
  { id: 'last30', key: 'rangeLast30', granularity: 'day' },
  { id: 'thisMonth', key: 'rangeThisMonth', granularity: 'day' },
  { id: 'lastMonth', key: 'rangeLastMonth', granularity: 'day' },
];
const DEFAULT_PRESET = 'thisMonth';
const SLOT_SEC = { hour: 3600, day: 86400 };

// 窗口的可读区间：日粒度 '2026-09-01 ~ 2026-09-30'；小时粒度 '2026-09-27 00:00 ~ 24:00'
function fmtRangeLabel(spec) {
  const ymd = (sec) => {
    const d = new Date(sec * 1000 + TZ8_OFFSET_MS);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  };
  if (spec.granularity === 'hour') {
    const a = new Date(spec.startSec * 1000 + TZ8_OFFSET_MS);
    const b = new Date(spec.endSec * 1000 + TZ8_OFFSET_MS);
    return `${ymd(spec.startSec)} ${pad2(a.getUTCHours())}:00 ~ ${pad2(b.getUTCHours())}:00`;
  }
  return `${ymd(spec.startSec)} ~ ${ymd(spec.endSec - 86400)}`;
}

function isPreset(id) { return RANGE_PRESET_DEFS.some((d) => d.id === id); }
function presetDef(id) {
  return RANGE_PRESET_DEFS.find((d) => d.id === id) || RANGE_PRESET_DEFS.find((d) => d.id === DEFAULT_PRESET);
}

// 窗口区间为左闭右开 [startSec, endSec)。今天/近7天/近30天/本月的 end 落在未来
// （官方用量页同样如此且平台接受）；渲染多少槽由 visibleSlotCount 决定，不裁剪请求。
// nowMs 可注入，便于对跨月、月初、月末等时刻做确定性测试。
function resolveRange(id, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const t = new Date(now + TZ8_OFFSET_MS);
  const y = t.getUTCFullYear(), mo = t.getUTCMonth() + 1, d = t.getUTCDate();
  const todayStart = tz8DayStartSec(y, mo, d);
  const monthStart = tz8DayStartSec(y, mo, 1);
  const def = presetDef(id);
  const mk = (startSec, endSec, granularity) => {
    const slotSec = SLOT_SEC[granularity];
    return { id: def.id, startSec, endSec, granularity, slotSec, slots: Math.round((endSec - startSec) / slotSec) };
  };
  if (def.id === 'today') return mk(todayStart, todayStart + 86400, 'hour');
  if (def.id === 'yesterday') return mk(todayStart - 86400, todayStart, 'hour');
  if (def.id === 'last7') return mk(todayStart - 6 * 86400, todayStart + 86400, 'day');
  if (def.id === 'last30') return mk(todayStart - 29 * 86400, todayStart + 86400, 'day');
  if (def.id === 'lastMonth') {
    const prev = new Date(Date.UTC(y, mo - 2, 1));   // mo-2：JS 月份从 0 起算，减 2 即上一月
    return mk(tz8DayStartSec(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 1), monthStart, 'day');
  }
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return mk(monthStart, tz8DayStartSec(y, mo, daysInMonth) + 86400, 'day');
}

// 绝对秒 → 所属槽的绝对秒。小时槽与 UTC 整点对齐（+08:00 恰为整小时）；
// 日槽必须按 GMT+8 日界：floor(ts/86400) 会按 UTC 分桶，即已修复过的 8 小时偏差。
function slotStartSec(tsSec, granularity) {
  if (granularity === 'hour') return Math.floor(tsSec / 3600) * 3600;
  return Math.floor((tsSec + TZ8_OFFSET_MS / 1000) / 86400) * 86400 - TZ8_OFFSET_MS / 1000;
}

// 可见槽数 = 已过去的槽 + 当前槽（"只画到今天/当前小时"，六种预设通用）
function visibleSlotCount(spec, nowMs) {
  const nowSec = Math.floor((nowMs == null ? Date.now() : nowMs) / 1000);
  const elapsed = Math.floor((nowSec - spec.startSec) / spec.slotSec) + 1;
  return Math.max(0, Math.min(spec.slots, elapsed));
}

// 窗口是否已覆盖"本月 1 日 → 现在"：为真时本月快照可复用窗口数据，省一次请求
function coversMonthToDate(spec, nowMs) {
  if (spec.granularity !== 'day') return false;
  const now = nowMs == null ? Date.now() : nowMs;
  const t = new Date(now + TZ8_OFFSET_MS);
  const monthStart = tz8DayStartSec(t.getUTCFullYear(), t.getUTCMonth() + 1, 1);
  return spec.startSec <= monthStart && spec.endSec > Math.floor(now / 1000);
}

async function fetchUsageRange(sessionToken, cookie, proxy, startSec, endSec) {
  const q = `?start=${startSec}&end=${endSec}&tz=28800`;
  const [amount, cost] = await Promise.all([
    fetchPlatformApi(sessionToken, cookie, proxy, `/api/v0/usage/by_api_key/amount${q}`),
    fetchPlatformApi(sessionToken, cookie, proxy, `/api/v0/usage/by_api_key/cost${q}`),
  ]);
  return { amount, cost };
}

// 桶时间 → 绝对 Unix 秒。数字按秒（>1e12 视为毫秒）；字符串无时区后缀时按 GMT+8 解析
function bucketSecOf(t) {
  if (typeof t === 'number') return Math.floor((t > 1e12 ? t : t * 1000) / 1000);
  if (t == null) return null;
  const str = String(t).trim();
  const ms = Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(str) ? str : str.replace(' ', 'T') + '+08:00');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}



const numOf = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

// 桶内用量归一化
function normUsage(u) {
  const out = { requests: 0, cacheHit: 0, cacheMiss: 0, output: 0 };
  if (Array.isArray(u)) {
    for (const it of u) {
      if (!it) continue;
      if (it.type === 'REQUEST') out.requests = numOf(it.amount);
      else if (it.type === 'PROMPT_CACHE_HIT_TOKEN') out.cacheHit += numOf(it.amount);
      else if (it.type === 'PROMPT_CACHE_MISS_TOKEN') out.cacheMiss += numOf(it.amount);
      else if (it.type === 'RESPONSE_TOKEN') out.output += numOf(it.amount);
    }
  } else if (u && typeof u === 'object') {
    out.requests = numOf(u.REQUEST);
    out.cacheHit = numOf(u.PROMPT_CACHE_HIT_TOKEN);
    out.cacheMiss = numOf(u.PROMPT_CACHE_MISS_TOKEN);
    out.output = numOf(u.RESPONSE_TOKEN);
  }
  return out;
}

// 桶内金额归一化：金额字段在不同接口/版本里可能是 usage.amount、usage[{amount}]、usage 本身或 bucket.amount
// 桶内金额：可识别时返回数值（可能为 0），无法识别时返回 null

function bucketCost(usage, bucket) {
  const pick = (v) => {
    if (v == null) return null;
    if (typeof v === 'number' || typeof v === 'string') return numOf(v);
    if (Array.isArray(v)) {
      const known = v.filter((it) => it && (it.amount != null || it.cost != null));
      if (!known.length) return null;
      return known.reduce((s, it) => s + numOf(it.amount != null ? it.amount : it.cost), 0);
    }
    if (typeof v === 'object') {
      if (v.amount != null) return numOf(v.amount);
      if (v.cost != null) return numOf(v.cost);
    }
    return null;
  };
  const u = pick(usage);
  if (u != null) return u;
  return pick(bucket && (bucket.amount != null ? bucket.amount : bucket.cost));
}

// 取 series 列表：amount 直接在 biz_data.series；cost 多套一层 —— biz_data.data = [{currency, series}]。
// 两种形状都收进来，避免接口再调整时又整条链路失效。
function seriesOf(apiJson) {
  const biz = apiJson && apiJson.data && apiJson.data.biz_data;
  if (!biz) return [];
  const out = [];
  for (const g of (Array.isArray(biz) ? biz : [biz])) {
    if (!g) continue;
    if (Array.isArray(g.series)) out.push(...g.series);
    const inner = Array.isArray(g.data) ? g.data : (g.data ? [g.data] : []);
    for (const sub of inner) if (sub && Array.isArray(sub.series)) out.push(...sub.series);
  }
  return out;
}

// 槽 → 展示元数据（date/label/tipHead 是唯一出现日期字符串的地方）
function barMeta(spec, idx) {
  const slotSec = spec.startSec + idx * spec.slotSec;
  const d = new Date(slotSec * 1000 + TZ8_OFFSET_MS);
  const date = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const ymd = `${d.getUTCFullYear()}-${date}`;
  if (spec.granularity === 'hour') {
    const hh = d.getUTCHours();
    const from = `${pad2(hh)}:00`;
    const to = hh === 23 ? '24:00' : `${pad2(hh + 1)}:00`;   // 末槽写 24:00，避免被读成次日 00:00
    return { kind: 'hour', key: `${ymd}T${pad2(hh)}`, date, hour: hh, from, to,
      label: [from], tipHead: `${date} ${from}–${to}` };   // 轴刻度只写起点（与官方一致），区间留给浮层
  }
  return { kind: 'day', key: ymd, date, day: d.getUTCDate(),
    label: [`${d.getUTCMonth() + 1}/${d.getUTCDate()}`], tipHead: ymd };
}

// 区间响应 → 窗口聚合。索引使用"绝对秒槽下标"，不使用日期字符串，
// 因此跨月/跨年的同日号不会相撞（近7天/近30天跨月时必须如此）。
// 返回 null 的唯一条件是金额字段结构无法识别（costSeen === 0）；金额为 0 属合法数据。
function aggregateUsageRange(amountJson, costJson, spec, nowMs) {
  const visible = visibleSlotCount(spec, nowMs);
  const slotMap = new Map();     // 槽下标 → Map(model → cell)
  const modelMap = new Map();
  let costBuckets = 0;           // 响应里可解析时间的成本桶总数（判断"结构是否认得"，与窗口无关）
  let costSeen = 0;              // 其中金额字段认得出的数量
  const cellAt = (idx, model) => {
    let byModel = slotMap.get(idx);
    if (!byModel) { byModel = new Map(); slotMap.set(idx, byModel); }
    let c = byModel.get(model);
    if (!c) { c = { cacheHit: 0, cacheMiss: 0, output: 0, requests: 0, cost: 0 }; byModel.set(model, c); }
    return c;
  };
  const absorb = (json, isCost) => {
    for (const series of seriesOf(json)) {
      const model = series.model || 'unknown';
      for (const b of series.buckets || []) {
        const ts = bucketSecOf(b.time);
        if (ts == null) continue;
        if (isCost) {
          costBuckets++;
          const c = bucketCost(b.usage, b);
          if (c == null) continue;                                             // 金额字段不认识：跳过，不按 0 记账
          costSeen++;
          if (ts < spec.startSec || ts >= spec.endSec) continue;               // 认得出金额但不在窗口内：只用于结构判定
          const ci = Math.round((slotStartSec(ts, spec.granularity) - spec.startSec) / spec.slotSec);
          if (ci < 0 || ci >= visible) continue;
          cellAt(ci, model).cost += c;
        } else {
          if (ts < spec.startSec || ts >= spec.endSec) continue;               // 左闭右开；平台溢出桶丢弃
          const idx = Math.round((slotStartSec(ts, spec.granularity) - spec.startSec) / spec.slotSec);
          if (idx < 0 || idx >= visible) continue;                             // 未来时段天然落在数组之外
          const u = normUsage(b.usage), cell = cellAt(idx, model);
          cell.requests += u.requests; cell.cacheHit += u.cacheHit;
          cell.cacheMiss += u.cacheMiss; cell.output += u.output;
        }
      }
    }
  };
  absorb(amountJson, false);
  absorb(costJson, true);
  // 只有"响应里确实有桶、却一个金额都认不出"才报错结构无法识别；
  // 响应为空（该窗口没有数据）是合法结果，必须如实返回全 0。
  if (costBuckets > 0 && costSeen === 0) return null;
  for (const byModel of slotMap.values()) {
    for (const [model, c] of byModel) {
      let m = modelMap.get(model);
      if (!m) { m = { model, cacheHit: 0, cacheMiss: 0, output: 0, cost: 0, requests: 0 }; modelMap.set(model, m); }
      m.cacheHit += c.cacheHit; m.cacheMiss += c.cacheMiss; m.output += c.output;
      m.requests += c.requests; m.cost += c.cost;
    }
  }
  const models = [...modelMap.values()].filter((m) => m.cacheHit + m.cacheMiss + m.output + m.requests > 0);
  const modelOrder = models.map((m) => m.model);
  const bars = [];
  for (let i = 0; i < visible; i++) {
    const byModel = slotMap.get(i) || new Map();
    // parts 按 models 顺序排列：颜色与浮层行序都依赖它，不能按金额排序
    const parts = modelOrder.filter((m) => byModel.has(m) && byModel.get(m).cost > 0)
      .map((m) => ({ model: m, cost: byModel.get(m).cost }));
    let tokens = 0;
    for (const c of byModel.values()) tokens += c.cacheHit + c.cacheMiss + c.output;
    bars.push(Object.assign(barMeta(spec, i), { cost: parts.reduce((sum, p) => sum + p.cost, 0), tokens, parts }));
  }
  return {
    spec, granularity: spec.granularity, slots: spec.slots, visible, models, bars,
    totalCost: models.reduce((sum, m) => sum + m.cost, 0),
    totalTokens: models.reduce((sum, m) => sum + m.cacheHit + m.cacheMiss + m.output, 0),
    totalReqs: models.reduce((sum, m) => sum + m.requests, 0),
  };
}



// ============================================================
//  Webview HTML Generator — Canvas Charts Dashboard
// ============================================================
//
// 数据不再拼进 HTML，只有面板创建和语言变化时才重建外壳，其余一律通过 postMessage 推送数据


function buildPanelHtml(i18n, langCode, selectedPreset) {
  const rangeOpts = RANGE_PRESET_DEFS
    .map((d) => `<option value="${d.id}"${d.id === selectedPreset ? ' selected' : ''}>${i18n[d.key]}</option>`).join('');
  const rangeIds = JSON.stringify(RANGE_PRESET_DEFS.map((d) => d.id));
  const htmlLang = langCode === 'en' ? 'en' : 'zh-CN';   // <html lang> 跟随语言设置

  return `<!DOCTYPE html><html lang="${htmlLang}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${i18n.title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);padding:20px 24px;font-size:13px}
h1{font-size:18px;font-weight:600}
.subtitle{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px;margin-bottom:16px}
.banner{margin-bottom:12px;padding:8px 12px;border-radius:6px;font-size:12px;background:var(--vscode-inputValidation-errorBackground,rgba(241,76,76,.12));border:1px solid var(--vscode-inputValidation-errorBorder,#f14c4c)}
.banner[hidden]{display:none}
.border{--card-border:var(--vscode-widget-border,rgba(128,128,128,.25))}
.cards-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.cards-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.card{background:var(--vscode-editorWidget-background,var(--vscode-input-background));border:1px solid var(--vscode-widget-border,rgba(128,128,128,.25));border-radius:6px;padding:14px 16px;min-width:0}
.card-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.card .label{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:6px}
.card .value{display:inline-block;font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.card .suffix{font-size:11px;color:var(--vscode-descriptionForeground);margin-left:6px}
.card .suffix[hidden]{display:none}
.card .sub{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px;min-height:14px}
.divider{border:none;border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.25));margin:18px 0 16px}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
.toolbar-l{display:flex;align-items:center;gap:8px}
.toolbar-label{font-size:12px;color:var(--vscode-descriptionForeground)}
.toolbar-r{display:flex;align-items:center;gap:10px}
.updated-at{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}
.range-select{padding:5px 10px;background:var(--vscode-input-background);color:var(--vscode-editor-foreground);border:1px solid var(--vscode-widget-border,rgba(128,128,128,.25));border-radius:4px;font-size:13px;cursor:pointer}
.btn{padding:5px 14px;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:500}
.btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.btn-primary:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
.btn-light{background:var(--vscode-button-secondaryBackground,var(--vscode-input-background));color:var(--vscode-button-secondaryForeground,var(--vscode-editor-foreground));border:1px solid var(--vscode-widget-border,rgba(128,128,128,.25));white-space:nowrap}
.btn-light:hover{background:var(--vscode-button-secondaryHoverBackground,var(--vscode-input-background))}
.btn:disabled{opacity:.5;cursor:not-allowed}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.chart-title{font-size:13px;font-weight:600}
.chart-total{margin-left:6px;font-variant-numeric:tabular-nums}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--vscode-descriptionForeground)}
.legend-item{display:flex;align-items:center;gap:5px}
.legend-dot{display:inline-block;width:8px;height:8px;border-radius:2px}
.chart-wrap canvas{display:block;width:100%}
#toast{position:fixed;top:10px;right:20px;z-index:999;padding:8px 16px;border-radius:4px;font-size:12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);box-shadow:0 2px 8px rgba(0,0,0,.3);transform:translateY(-100px);transition:transform .2s;pointer-events:none}
#toast.show{transform:translateY(0)}
#chart-tip{position:fixed;pointer-events:none;z-index:998;background:var(--vscode-editorWidget-background,var(--vscode-input-background));color:var(--vscode-editor-foreground);border:1px solid var(--vscode-widget-border,rgba(128,128,128,.25));border-radius:6px;padding:10px 14px;font-size:11px;line-height:1.6;box-shadow:0 4px 12px rgba(0,0,0,.3);opacity:0;transition:opacity .15s;max-width:300px}
#chart-tip.show{opacity:1}
#chart-tip .tip-row{display:flex;justify-content:space-between;gap:18px;white-space:nowrap}
#chart-tip .tip-row span:last-child{font-variant-numeric:tabular-nums}
#chart-tip .tip-head{font-weight:600;padding-bottom:5px;margin-bottom:5px;border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.25))}
#chart-tip .tip-dot{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:6px;vertical-align:middle}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.head-actions{display:flex;align-items:center;gap:8px}
</style></head>
<body><div id="toast"></div><div id="chart-tip"></div>

<div class="panel-head">
  <h1>${i18n.usageTitle}</h1>
  <div class="head-actions">
    <button class="btn btn-light" id="setApiKeyBtn">${i18n.setApiKey}</button>
    <button class="btn btn-light" id="settingsBtn">${i18n.settings}</button>
  </div>
</div>
<div class="subtitle">${i18n.tzNote}</div>
<div id="errBanner" class="banner" hidden></div>

<div class="cards-2">
  <div class="card">
    <div class="card-row">
      <div style="min-width:0">
        <div class="label">${i18n.toppedUpBalance}</div>
        <div class="value" id="topupValue">—</div><span class="suffix" id="topupSuffix" hidden>CNY</span>
      </div>
    </div>
    <div class="sub" id="topupSub"></div>
  </div>
  <div class="card">
    <div class="label">${i18n.todayCost}</div>
    <div class="value" id="todayValue">—</div><span class="suffix" id="todaySuffix" hidden>CNY</span>
    <div class="sub" id="todaySub"></div>
  </div>
</div>

<hr class="divider">

<div class="toolbar">
  <div class="toolbar-l">
    <span class="toolbar-label">${i18n.rangeLabel}</span>
    <select class="range-select" id="rangeSelect">${rangeOpts}</select>
  </div>
  <div class="toolbar-r">
    <span class="updated-at" id="updatedAt" hidden></span>
    <button class="btn btn-primary" id="refreshBtn">${i18n.refresh}</button>
  </div>
</div>

<div class="cards-3">
  <div class="card">
    <div class="label">${i18n.costAmount}</div>
    <div class="value" id="mCost">—</div><span class="suffix" id="mCostSuffix" hidden>CNY</span>
  </div>
  <div class="card">
    <div class="label">${i18n.apiRequests}</div>
    <div class="value" id="mReqs">—</div>
  </div>
  <div class="card">
    <div class="label">${i18n.tokens}</div>
    <div class="value" id="mTokens">—</div>
  </div>
</div>

<div class="card" style="margin-top:12px">
  <div class="card-head">
    <div class="chart-title">${i18n.costCny}<span class="chart-total" id="chartTotal"></span></div>
    <div class="legend" id="costLegend"></div>
  </div>
  <div class="chart-wrap" id="costWrap"><canvas id="costChart" style="width:100%;height:260px"></canvas></div>
</div>

<script>
(function() {
const vsc = acquireVsCodeApi();
// 固定文案仅重建外壳时更新；运行期动态文案随数据一起推送更新
var I18N = ${JSON.stringify(i18n).replace(/</g, '\\u003c')};
var RANGE_IDS = ${rangeIds};
var D = null;                 // 最近一次由扩展推送的数据
var busySafety = null;        // 刷新按钮的兜底解锁计时器

// 官方「消费金额」柱状图色阶（截图像素采样）；按 models 下标分配，超出后追加备用色
var COST_COLORS = ['#FFAA00', '#FF8800', '#FF5500', '#FFCC66', '#CC4400', '#994400'];

function i18n() { return (D && D.i18n) || I18N || {}; }
function fmtCost(n) { return (parseFloat(n) || 0).toFixed(2); }
function fmtInt(n) { return Math.round(parseFloat(n) || 0).toLocaleString('en-US'); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function p2(n) { return (n < 10 ? '0' : '') + n; }
// 数据更新时间：面板所有时间统一按 GMT+8（与 tzNote 一致）。
// short=true 用于正文（同一 GMT+8 日只给 HH:MM:SS，跨日带月-日），short=false 用于 title（完整 YYYY-MM-DD HH:MM:SS）
function fmtClock8(ms, short) {
  var t = new Date(ms + 8 * 3600 * 1000), now = new Date(Date.now() + 8 * 3600 * 1000);
  var ymd = t.getUTCFullYear() + '-' + p2(t.getUTCMonth() + 1) + '-' + p2(t.getUTCDate());
  var nowYmd = now.getUTCFullYear() + '-' + p2(now.getUTCMonth() + 1) + '-' + p2(now.getUTCDate());
  var hms = p2(t.getUTCHours()) + ':' + p2(t.getUTCMinutes()) + ':' + p2(t.getUTCSeconds());
  if (!short) return ymd + ' ' + hms;
  return ymd === nowYmd ? hms : (ymd.slice(5) + ' ' + hms);
}
function modelOrder() { return ((D && D.models) || []).map(function(m) { return m.model; }); }
// 颜色必须由「模型在全局 models 中的序号」决定，不能由当日在 parts 里的下标决定，
// 否则某天只有 model2、另一天只有 model1 时两者会同色
function colorOf(model) {
  var i = modelOrder().indexOf(model);
  return COST_COLORS[(i >= 0 ? i : COST_COLORS.length - 1) % COST_COLORS.length];
}

// Toast
var toastTimer = null;
function toast(msg) { var e = document.getElementById('toast'); e.textContent = msg; e.className = 'show'; clearTimeout(toastTimer); toastTimer = setTimeout(function() { e.className = ''; }, 2000); }

// Theme-aware grid color
function gridColor() {
  var bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
  var v = parseInt(bg.replace('#', ''), 16);
  if (isNaN(v)) return '#888';
  return v < 0x888888 ? '#444' : '#ddd';
}

// ===== CANVAS HELPERS =====
function getCtx(id) {
  var c = document.getElementById(id); if(!c) return null;
  var dpr = window.devicePixelRatio||1;
  var rect = c.getBoundingClientRect();
  c.width = rect.width * dpr; c.height = rect.height * dpr;
  var ctx = c.getContext('2d'); ctx.scale(dpr,dpr);
  c.ctx = ctx; c.cw = rect.width; c.ch = rect.height;
  return ctx;
}

function drawHLine(ctx, w, y, color, x1, x2) {
  ctx.strokeStyle = color||gridColor(); ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(x1||0, y); ctx.lineTo(x2||w, y); ctx.stroke();
}

// ===== TOOLTIP HELPERS =====
function showChartTip(evt, html) {
  var e = document.getElementById('chart-tip');
  e.innerHTML = html; e.className = 'show';
  var vw = window.innerWidth, vh = window.innerHeight;
  e.style.left = Math.max(8, Math.min(evt.clientX + 14, vw - e.offsetWidth - 12)) + 'px';
  e.style.top = Math.max(8, Math.min(evt.clientY - 10, vh - e.offsetHeight - 12)) + 'px';
}
function hideChartTip() { document.getElementById('chart-tip').className = ''; }

// ===== AXIS HELPERS =====
function niceMax(v) {
  if (!(v > 0)) return 1;
  var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), f = v / e;
  var n = f <= 1 ? 1 : f <= 1.5 ? 1.5 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 3 ? 3
        : f <= 4 ? 4 : f <= 5 ? 5 : f <= 6 ? 6 : f <= 8 ? 8 : 10;
  return n * e;
}
function fmtAxis(v) {
  if (v === 0) return '0';
  if (v >= 100) return String(Math.round(v));
  if (v >= 1) return String(Math.round(v * 10) / 10);
  return v.toFixed(2);
}
function drawEmpty(ctx, w, h, text) {
  ctx.fillStyle = gridColor(); ctx.font = '12px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text || '', w / 2, h / 2);
  ctx.textBaseline = 'alphabetic';
}

// ===== DAILY COST STACKED BAR CHART =====
var costBars = [];

function tipHtml(b) {
  var rows = '<div class="tip-row tip-head"><span>' + esc(b.tipHead || b.date) + '</span><span>¥' + fmtCost(b.cost) + '</span></div>';
  (b.parts || []).forEach(function(p) {
    rows += '<div class="tip-row"><span><i class="tip-dot" style="background:' + colorOf(p.model) + '"></i>' + esc(p.model) + '</span><span>¥' + fmtCost(p.cost) + '</span></div>';
  });
  return rows;
}

function drawCostBars(canvas, bars, granularity) {
  try {
    var ctx = getCtx(canvas.id); if (!ctx) return;
    var w = canvas.cw, h = canvas.ch;
    if (w < 40 || h < 40) return;   // 面板不可见时 getBoundingClientRect 全 0，会让 slot 变成 NaN

    var emptyText = !(D && D.hasCreds) ? i18n().noSessionToken : (D.error ? i18n().loadFailed : i18n().noDataRange);
    if (!bars || !bars.length) { drawEmpty(ctx, w, h, emptyText); costBars = []; return; }

    var maxRaw = 0;
    bars.forEach(function(b) { if (b.cost > maxRaw) maxRaw = b.cost; });
    if (maxRaw <= 0) { drawEmpty(ctx, w, h, emptyText); costBars = []; return; }

    var pad = { top: 12, right: 16, bottom: 26, left: 52 };
    var pw = w - pad.left - pad.right, ph = h - pad.top - pad.bottom;
    var n = bars.length, slot = pw / n;
    var barW = Math.max(2, Math.min(18, slot * 0.72));
    var max = niceMax(maxRaw), steps = 4;

    // y 轴网格与刻度
    ctx.font = '10px sans-serif';
    for (var i = 0; i <= steps; i++) {
      var y = pad.top + ph * (1 - i / steps);
      drawHLine(ctx, w, y, undefined, pad.left, w - pad.right);
      ctx.fillStyle = gridColor(); ctx.textAlign = 'right';
      ctx.fillText(fmtAxis(max * i / steps), pad.left - 6, y + 3);
    }

    // 柱子 + 按模型堆叠（底部 = models[0]）
    costBars = [];
    bars.forEach(function(b, i) {
      var x = pad.left + i * slot + (slot - barW) / 2;
      var sy = pad.top + ph;
      var parts = b.parts || [];
      parts.forEach(function(p) {
        var sh = ph * (p.cost / max);
        if (sh <= 0) return;
        sy -= sh;
        ctx.fillStyle = colorOf(p.model);
        ctx.fillRect(x, sy, barW, sh);
      });
      costBars.push({ x: pad.left + i * slot, w: slot, bar: b });
    });

    // x 轴刻度：与官方用量页一致 —— 在首末之间均匀取若干个（首末必有），单行标注
    var maxLabels = Math.max(2, Math.min(6, Math.floor(pw / 150)));
    var count = Math.min(n, maxLabels);
    var idxs = [];
    for (var li = 0; li < count; li++) {
      var ix2 = count === 1 ? 0 : Math.round(li * (n - 1) / (count - 1));
      if (idxs.indexOf(ix2) < 0) idxs.push(ix2);
    }
    ctx.textAlign = 'center'; ctx.fillStyle = gridColor(); ctx.font = '10px sans-serif';
    idxs.forEach(function(i2) {
      var labels = bars[i2].label || [];
      var cx = pad.left + i2 * slot + slot / 2;
      for (var k = 0; k < labels.length; k++) ctx.fillText(labels[k], cx, pad.top + ph + 14 + k * 11);
    });

    // 按格命中（31 根细柱按柱命中太难）
    canvas.onmousemove = function(e) {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      var mx = (e.clientX - rect.left) * (canvas.cw / rect.width);
      if (mx < pad.left || mx > pad.left + pw) { hideChartTip(); return; }
      var idx = Math.floor((mx - pad.left) / slot);
      if (idx < 0 || idx >= costBars.length) { hideChartTip(); return; }
      showChartTip(e, tipHtml(costBars[idx].bar));
    };
    canvas.onmouseleave = hideChartTip;
  } catch (e2) { console.error('drawCostBars:', e2); }
}

// ===== RENDER =====
function setText(id, text) { var e = document.getElementById(id); if (e) e.textContent = text; }
function show(id, visible) { var e = document.getElementById(id); if (e) e.hidden = !visible; }

function render() {
  var L = i18n();
  var d = D || {};

  // 顶部错误横条（session 过期等）
  var eb = document.getElementById('errBanner');
  if (d.error) { eb.textContent = d.errorText || d.error; eb.title = d.errorText ? d.error : ''; eb.hidden = false; } else { eb.hidden = true; eb.title = ''; }

  // 数据更新时间（刷新按钮左侧）；未成功取过数据时不显示
  if (d.updatedAt) {
    setText('updatedAt', L.updatedAtLabel.replace('{0}', fmtClock8(d.updatedAt, true)));
    document.getElementById('updatedAt').title = fmtClock8(d.updatedAt, false) + ' (GMT+8)';
  }
  show('updatedAt', !!d.updatedAt);

  // 卡A：充值余额（topped_up_balance，与官方「充值余额」同口径）
  if (d.hasBalance && d.bal) {
    setText('topupValue', '¥' + fmtCost(d.bal.toppedUp)); show('topupSuffix', true);
    var subs = [];
    if (d.bal.granted > 0) subs.push(L.granted + ': ¥' + fmtCost(d.bal.granted));
    if (d.bal.insufficient) subs.push(L.balanceInsufficient);
    if (d.keyDegraded) subs.push(L.keySessionOnly);
    setText('topupSub', subs.join(' · '));
  } else {
    setText('topupValue', '—'); show('topupSuffix', false);
    setText('topupSub', d.keyDegraded ? (L.errNoApiKey + ' · ' + L.keySessionOnly) : L.errNoApiKey);
  }

  // 卡B：今日消费（始终表示今天，与图表所选窗口无关）
  if (d.hasToday) {
    setText('todayValue', '¥' + fmtCost(d.todayCost)); show('todaySuffix', true);
    setText('todaySub', d.todayDate + ' · GMT+8');
  } else {
    setText('todayValue', '—'); show('todaySuffix', false);
    setText('todaySub', !d.hasCreds ? L.noSessionToken : L.loadFailed);
  }

  // 三张指标卡
  if (d.hasUsage) {
    setText('mCost', '¥' + fmtCost(d.totalCost)); show('mCostSuffix', true);
    setText('mReqs', fmtInt(d.totalReqs));
    setText('mTokens', fmtInt(d.totalTokens));
  } else {
    setText('mCost', '—'); show('mCostSuffix', false);
    setText('mReqs', '—'); setText('mTokens', '—');
  }

  // 图表卡：合计 + 图例
  setText('chartTotal', d.hasUsage ? '¥' + fmtCost(d.totalCost) : '');
  var lg = '';
  (d.models || []).forEach(function(m) {
    if (!m.cost) return;
    lg += '<span class="legend-item"><i class="legend-dot" style="background:' + colorOf(m.model) + '"></i>' + esc(m.model) + '</span>';
  });
  document.getElementById('costLegend').innerHTML = lg;
}

// 时间窗口下拉：选项静态内联在外壳里，这里只同步选中值，并挂上区间说明
function syncRanges() {
  var sel = document.getElementById('rangeSelect'); if (!sel || !D || !D.preset) return;
  if (RANGE_IDS.indexOf(D.preset) >= 0 && sel.value !== D.preset) sel.value = D.preset;
  sel.title = D.rangeLabel || '';
}

// 画图：面板首次可见前 canvas 尺寸可能还是 0，用 rAF 重试一次
function drawChart(retried) {
  var c = document.getElementById('costChart'); if (!c) return;
  var r = c.getBoundingClientRect();
  if ((!r.width || !r.height) && !retried) { requestAnimationFrame(function() { drawChart(true); }); return; }
  drawCostBars(c, D && D.hasUsage ? D.bars : [], D && D.granularity);
}

function setBusy(busy) {
  var btn = document.getElementById('refreshBtn'); if (!btn) return;
  btn.disabled = !!busy; btn.textContent = busy ? '...' : (i18n().refresh || 'Refresh');
}

function post(type, extra) {
  var m = { type: type };
  for (var k in extra) m[k] = extra[k];
  vsc.postMessage(m);
}

function armBusySafety() {
  if (busySafety) clearTimeout(busySafety);
  // 防止请求无返回时刷新按钮卡死，30 秒后自动解锁按钮
  busySafety = setTimeout(function() { busySafety = null; setBusy(false); }, 30000);
}

function applyData(payload) {
  D = payload || {}; if (!D.i18n) D.i18n = I18N;
  render(); syncRanges(); drawChart();
  setBusy(!!D.busy);
  if (!D.busy && busySafety) { clearTimeout(busySafety); busySafety = null; }
}

window.addEventListener('message', function(ev) {
  var m = ev.data || {};
  if (m.type === 'data') applyData(m.data);
});

// ===== ACTIONS =====
function doRefresh() {
  setBusy(true); armBusySafety();
  toast(i18n().refresh + '...');
  post('refresh');
}

function onRangeChange() {
  var sel = document.getElementById('rangeSelect');
  setBusy(true); armBusySafety();
  toast(i18n().loading);
  post('changeRange', { preset: sel.value });
}

// ---- CSP-safe event binding (no inline onclick/onchange) ----
document.getElementById('refreshBtn').addEventListener('click', doRefresh);
document.getElementById('rangeSelect').addEventListener('change', onRangeChange);
document.getElementById('setApiKeyBtn').addEventListener('click', function() {
  post('setApiKey');
});
document.getElementById('settingsBtn').addEventListener('click', function() {
  post('openSettings');
});

// ---- ResizeObserver: 面板尺寸变化时重绘图表 ----
var resizeDebounce = null;
var ro = new ResizeObserver(function() {
  if (resizeDebounce) clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(function() { drawChart(true); }, 200);
});
ro.observe(document.getElementById('costWrap'));

// 首屏 — 占位，图表显示"加载中"，等待扩展推送数据
(function() {
  var c = document.getElementById('costChart'); if (!c) return;
  var ctx = getCtx(c.id);
  if (ctx) drawEmpty(ctx, c.cw, c.ch, I18N.loading || '');
})();
syncRanges();
post('ready');
})();
</script></body></html>`;
}

// ============================================================
//  Extension Activation
// ============================================================

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  const i18n = t();
  const config = () => vscode.workspace.getConfiguration('deepseek-usage-monitor');
  const langKey = () => config().get('language', 'zh-cn');

  // ---- Status bar ----
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
  statusBarItem.command = 'deepseek-usage-monitor.showUsage';
  statusBarItem.text = '$(sync~spin) DeepSeek Usage';
  statusBarItem.tooltip = i18n.loading;
  statusBarItem.show();

  // ---- Config ----
  // secrets 读取：带超时兜底 + 内存缓存（详见文件顶部注释）
  let apiKeyCache; // undefined=还没读到；''=确认没有；'sk-...'=有
  let secretsReadOnce = null;  // 只发起一次 secrets.get，超时后不反复发起
  let lateWaitRunning = false;

  // 系统密钥环不可用：key 只能放在内存缓存中，重启后需重输
  let keyDegraded = false;
  let keyReadWarned = false;
  // 标记：本机曾经成功保存过 key。下次会话若读不到，说明底层并未持久化（VSCode 会静默回退到内存）
  const SAVED_MARKER = 'deepseekUsage.savedKeyAt';
  function warnKeyReadFailed(reason) {          // 每次会话只提示一次，避免反复弹窗
    keyDegraded = true;
    if (keyReadWarned) return;
    keyReadWarned = true;
    vscode.window.showWarningMessage(tf('keyringUnavailable', reason));
  }

  function configApiKey() { return config().get('apiKey', '') || ''; }

  function withTimeout(promise, ms) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ timedOut: true }); } }, ms);
      Promise.resolve(promise).then(
        (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ value }); } },
        (error) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ error }); } },
      );
    });
  }

  // 读一次 secrets（超时即返回，不阻塞调用方）
  async function warmApiKey() {
    if (apiKeyCache !== undefined) return false;
    if (!secretsReadOnce) secretsReadOnce = Promise.resolve(context.secrets.get(SECRETS_KEY));
    const r = await withTimeout(secretsReadOnce, SECRETS_TIMEOUT_MS);
    if (r.timedOut) {
      warnKeyReadFailed(tf('keyReadTimeout', SECRETS_TIMEOUT_MS));
      waitForLateApiKey();
      return false;
    }
    if (r.error) { warnKeyReadFailed((r.error && r.error.message) || tf('keyReadFailed')); return false; }
    apiKeyCache = r.value || '';
    if (!apiKeyCache && context.globalState.get(SAVED_MARKER)) {
      // 上次确实存过、这次读不到 → 底层存储没能持久化
      warnKeyReadFailed(tf('keyNotPersisted'));
    }
    return !!apiKeyCache;
  }

  // 超时后台继续等待：收到实际API Key值时补进缓存，并立即刷新一次
  function waitForLateApiKey() {
    if (lateWaitRunning || !secretsReadOnce) return;
    lateWaitRunning = true;
    secretsReadOnce.then((v) => {
      lateWaitRunning = false;
      if (apiKeyCache !== undefined) return;   // 期间用户已存过新 key，防止旧值覆盖
      apiKeyCache = v || '';
      if (apiKeyCache) refresh(undefined, 'late-key');
    }, () => { lateWaitRunning = false; });
  }

  // 等不到 secrets 响应就降级为内存缓存立即生效，API Key只在本次会话有效
  async function setApiKey(key) {
    apiKeyCache = key;
    const r = await withTimeout(Promise.resolve(context.secrets.store(SECRETS_KEY, key)), SECRETS_TIMEOUT_MS);
    const persisted = !r.timedOut && !r.error;
    // 记下"存过"这件事：下次会话读不到就说明底层未持久化
    if (persisted) { Promise.resolve(context.globalState.update(SAVED_MARKER, Date.now())).catch(() => {}); }
    return persisted;
  }

  async function getConfig() {
    const cfg = config();
    // 首次调用后台预热（不 await），这样刷新永远不被 secrets 拖住
    if (apiKeyCache === undefined) {
      warmApiKey().then((got) => { if (got) refresh(undefined, 'key-ready'); }).catch(() => {});
    }
    return {
      apiKey: apiKeyCache !== undefined ? (apiKeyCache || configApiKey()) : configApiKey(),
      sessionToken: cfg.get('sessionToken', '') || '', cookie: cfg.get('cookie', '') || '', proxy: cfg.get('proxy', '') || '',
    };
  }

  // ---- Data ----
  // usage = 所选窗口（喂图表与三项指标）；month = 与窗口无关的本月快照（喂今日卡与状态栏）
  let latestData = { balance: null, usage: null, month: null, hasCreds: false, error: null, errorText: null };
  let lastUpdatedAt = null;   // 最近一次成功取到数据的时刻（面板显示"数据更新时间"）
  // 面板时间窗口：读取持久化值，非法或已删除的 id 一律回落默认预设
  let currentPreset = (() => { const v = context.globalState.get(PRESET_STATE_KEY); return isPreset(v) ? v : DEFAULT_PRESET; })();
  function savePreset(id) { Promise.resolve(context.globalState.update(PRESET_STATE_KEY, id)).catch(() => {}); }
  let refreshInFlight = null;   // 进行中的刷新 Promise；null = 空闲
  let refreshQueued = null;     // 执行期间到达的刷新请求，仅保留最后一次，结束后补跑；用于串行化，避免并发写 latestData 与重复请求
  let refreshBusy = false;      // 刷新状态标志

  // 用窗口区间取用量；结构无法识别时如实报错，不做静默回退
  async function fetchUsageSpec(sessionToken, cookie, proxy, spec, nowMs) {
    const { amount, cost } = await fetchUsageRange(sessionToken, cookie, proxy, spec.startSec, spec.endSec);
    const agg = aggregateUsageRange(amount, cost, spec, nowMs);
    if (!agg) throw new Error('Invalid response (unrecognized usage payload)');
    return agg;
  }

  // 与窗口无关的本月快照。优先用独立拉取的本月窗口；窗口自身已覆盖"本月 1 日 → 现在"时复用窗口数据；
  // 都不满足（昨天 / 上月）时今日值未知，如实返回 null（面板与状态栏显示 —）。
  function buildMonthSnapshot({ monthAgg, windowAgg, spec, nowMs }) {
    const now = nowMs == null ? Date.now() : nowMs;
    const t8 = new Date(now + TZ8_OFFSET_MS);
    const todayDate = `${pad2(t8.getUTCMonth() + 1)}-${pad2(t8.getUTCDate())}`;
    const lastOf = (agg) => (agg && agg.bars.length ? agg.bars[agg.bars.length - 1] : null);
    if (monthAgg) {
      const bar = lastOf(monthAgg);   // 本月窗口的最后一根即今天
      return { totalCost: monthAgg.totalCost, todayCost: bar ? bar.cost : 0, todayTokens: bar ? bar.tokens : 0, todayDate };
    }
    if (!windowAgg) return null;
    if (coversMonthToDate(spec, now)) {
      const bar = lastOf(windowAgg);
      return { totalCost: windowAgg.totalCost, todayCost: bar ? bar.cost : 0, todayTokens: bar ? bar.tokens : 0, todayDate };
    }
    if (spec.id === 'today') {
      return { totalCost: null, todayCost: windowAgg.totalCost, todayTokens: windowAgg.totalTokens, todayDate };
    }
    if (spec.granularity === 'day') {
      const bar = lastOf(windowAgg);
      if (bar && bar.date === todayDate) return { totalCost: null, todayCost: bar.cost, todayTokens: bar.tokens, todayDate };
    }
    return { totalCost: null, todayCost: null, todayTokens: null, todayDate };
  }

  async function refreshAllData(presetId, nowMs) {
    const now = nowMs == null ? Date.now() : nowMs;
    if (isPreset(presetId)) currentPreset = presetId;
    const spec = resolveRange(currentPreset, now);

    const cfg = await getConfig();
    const hasCreds = !!(cfg.sessionToken && cfg.cookie);
    const needMonth = hasCreds && !coversMonthToDate(spec, now);
    latestData = { balance: null, usage: null, month: null, hasCreds, error: null, errorText: null };

    const results = await Promise.allSettled([
      cfg.apiKey ? fetchBalance(cfg.apiKey) : Promise.reject(new Error('no-api-key')),
      hasCreds ? fetchUsageSpec(cfg.sessionToken, cfg.cookie, cfg.proxy, spec, now) : Promise.reject(new Error('no-session')),
      needMonth ? fetchUsageSpec(cfg.sessionToken, cfg.cookie, cfg.proxy, resolveRange('thisMonth', now), now) : Promise.resolve(null),
    ]);

    const errors = [];
    const pushErr = (scope, m) => { if (!errors.some(([sc, mm]) => sc === scope && mm === m)) errors.push([scope, m]); };
    if (results[0].status === 'fulfilled') latestData.balance = results[0].value;
    else if (results[0].reason.message !== 'no-api-key') pushErr('Balance', results[0].reason.message);
    if (results[1].status === 'fulfilled') latestData.usage = results[1].value;
    else if (results[1].reason.message !== 'no-session') pushErr('Usage', results[1].reason.message);
    const monthAgg = results[2].status === 'fulfilled' ? results[2].value : null;
    if (results[2].status === 'rejected' && needMonth) pushErr('Usage', results[2].reason.message);
    latestData.month = buildMonthSnapshot({ monthAgg, windowAgg: latestData.usage, spec, now });
    // error 保留异常原文（面板 hover、日志排查用）；errorText 是展示给用户的本地化文案
    latestData.error = errors.length ? errors.map(([scope, m]) => scope + ': ' + m).join(' | ') : null;
    latestData.errorText = errors.length
      ? errors.map(([scope, m]) => tf('errEntry', scope === 'Balance' ? t().errScopeBalance : t().errScopeUsage, humanizeError(m))).join(' | ')
      : null;

    if (latestData.balance || latestData.usage || latestData.month) lastUpdatedAt = Date.now();

    updateStatusBar();
  }

  // 刷新入口：串行化执行，同一时刻至多一次；执行期间到达的请求合并为一次尾随刷新
  function refresh(presetId, source) {
    if (refreshInFlight) { refreshQueued = { preset: presetId, source }; return refreshInFlight; }
    refreshBusy = true;
    pushData(); // 推送 busy=true，供按钮反馈
    refreshInFlight = (async () => {
      try { await refreshAllData(presetId, undefined); }
      // 兜底：刷新流程本身抛异常（非接口错误）时同样给出两份文案，避免 errorText 残留上一次的
      catch (e) { latestData.error = (e && e.message) || String(e); latestData.errorText = humanizeError(latestData.error); }
      finally {
        refreshBusy = false; refreshInFlight = null;
        const q = refreshQueued; refreshQueued = null;
        pushData(); // 推送数据（或错误）
        if (q) refresh(q.preset, q.source);
      }
    })();
    return refreshInFlight;
  }

  // 状态栏显示项由设置 deepseek-usage-monitor.statusBar.items 决定显示内容和项目顺序
  const SB_DEFAULT_ITEMS = ['todayCost', 'balance'];
  const fmtMoney = (label, v) => `${label}:${v == null ? '—' : '¥' + v}`;
  const fmtThousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  function buildStatusSegments({ today, cost, balTotal, todayTokens }) {
    const i18n = t();
    const configured = config().get('statusBar.items', SB_DEFAULT_ITEMS);
    const items = Array.isArray(configured) ? configured : SB_DEFAULT_ITEMS;
    const segs = [];
    for (const item of items) {
      if (item === 'todayCost') segs.push(fmtMoney(i18n.sbTodayCost, today));
      else if (item === 'monthCost') segs.push(fmtMoney(i18n.sbMonthCost, cost));
      else if (item === 'balance') segs.push(fmtMoney(i18n.sbBalance, balTotal));
      else if (item === 'todayTokens') segs.push(`${i18n.sbTodayTokens} ${todayTokens == null ? '—' : fmtThousands(todayTokens)} ${i18n.tokens}`);
    }
    return segs;
  }

  function updateStatusBar() {
    const { balance, usage, month, error, errorText } = latestData;
    if (error) { statusBarItem.text = '$(error) DeepSeek Usage'; statusBarItem.tooltip = errorText ? `${errorText}\n(${error})` : error; statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground'); return; }
    const bal = balance?.balance_infos?.[0]; const balTotal = bal ? parseFloat(bal.total_balance).toFixed(2) : null;
    // 状态栏的"本月/本日"恒为当前月与今天，与面板所选窗口无关
    const cost = month && month.totalCost != null ? month.totalCost.toFixed(2) : null;
    const today = month && month.todayCost != null ? month.todayCost.toFixed(2) : null;
    const todayTokens = month && month.todayTokens != null ? month.todayTokens : null;

    // 未配置任何凭证时保留引导，避免状态栏显示一长串 —
    if (!balTotal && !month && !usage) {
      statusBarItem.text = '$(key) DeepSeek Usage';
      statusBarItem.tooltip = keyDegraded ? `${t().errNoApiKey}\n${t().keySessionOnly}` : t().errNoApiKey;
      statusBarItem.backgroundColor = undefined;
      return;
    }

    const segs = buildStatusSegments({ today, cost, balTotal, todayTokens });
    statusBarItem.text = segs.length ? `$(credit-card) DeepSeek Usage ${segs.join(' | ')}` : '$(credit-card) DeepSeek Usage';
    statusBarItem.tooltip = `${t().sbMonthCost}: ¥${cost ?? '—'} | ${t().sbTodayCost}: ¥${today ?? '—'} | ${t().sbBalance}: ¥${balTotal ?? '—'}\n${t().clickDetails}`
      + (keyDegraded ? `\n${t().keySessionOnly}` : '');
    statusBarItem.backgroundColor = undefined;
  }

  // ---- Webview Panel ----
  let currentPanel = null;
  let panelReady = false;   // webview 脚本就绪标志位，收到 ready后才能 postMessage 推送数据
  let panelLang = null;     // 当前外壳用的语言，变化后重建外壳

  // 面板数据载荷（结构对应 webview 里的 D）
  function buildPayload() {
    const { balance, usage, month, error, errorText, hasCreds } = latestData;
    const spec = resolveRange(currentPreset);
    const balInfo = (balance && Array.isArray(balance.balance_infos) && balance.balance_infos.length) ? balance.balance_infos[0] : null;
    const bal = balInfo ? {
      toppedUp: parseFloat(balInfo.topped_up_balance) || 0,
      granted: parseFloat(balInfo.granted_balance) || 0,
      // is_available 是"余额是否足以继续调用 API"的标志，为 false 时数字仍然有效，只降级成一行提示
      insufficient: balance.is_available === false,
    } : null;
    return {
      i18n: t(),
      preset: currentPreset,                        // 六个预设 id 之一
      rangeLabel: fmtRangeLabel(spec),              // 悬停下拉时显示具体区间
      rangeStart: spec.startSec, rangeEnd: spec.endSec,
      granularity: usage ? usage.granularity : spec.granularity,   // 失败时仍按预设，空图坐标轴才正确
      bucket: usage ? usage.spec.slotSec : spec.slotSec,
      busy: refreshBusy,
      keyDegraded,
      error: error || null,
      errorText: errorText || null,
      updatedAt: lastUpdatedAt,
      hasBalance: !!balInfo, bal,
      hasCreds,                                     // 区分"没配凭证"与"拉取失败"
      hasUsage: !!usage,
      models: usage ? usage.models : [], bars: usage ? usage.bars : [],
      totalCost: usage ? usage.totalCost : 0, totalTokens: usage ? usage.totalTokens : 0, totalReqs: usage ? usage.totalReqs : 0,
      monthCost: month ? month.totalCost : null,    // 与窗口无关
      hasToday: !!(month && month.todayCost != null),
      todayDate: month ? month.todayDate : '', todayCost: month ? month.todayCost : null, todayTokens: month ? month.todayTokens : null,
    };
  }

  function pushData() {
    if (!currentPanel || !panelReady) return;   // 未就绪：收到 ready 后统一向窗口推送一次数据
    const payload = buildPayload();
    currentPanel.webview.postMessage({ type: 'data', data: payload });
  }

  function rebuildShell() {
    if (!currentPanel) return;
    panelReady = false;
    panelLang = langKey();
    currentPanel.webview.html = buildPanelHtml(t(), langKey(), currentPreset);
  }

  function openUsagePanel() {
    if (currentPanel) {
      currentPanel.reveal();
      if (panelLang !== langKey()) rebuildShell(); else pushData();
      return;
    }
    currentPanel = vscode.window.createWebviewPanel('deepseekUsage', t().title, vscode.ViewColumn.Two, { enableScripts: true, retainContextWhenHidden: true });
    panelReady = false; panelLang = langKey();
    // 外壳只在这里（以及语言变化时）设置一次
    currentPanel.webview.html = buildPanelHtml(t(), langKey(), currentPreset);

    currentPanel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === 'ready') {
          panelReady = true;
          pushData();
          // 首屏可能还没有数据（激活时的首次刷新仍在等待返回），这里补推一次数据
          if (!refreshInFlight && !latestData.balance && !latestData.usage) refresh(undefined, 'ready');
        } else if (msg.type === 'refresh') {
          await refresh(undefined, 'panel');
        } else if (msg.type === 'changeRange') {
          const id = String(msg.preset || '');
          if (!isPreset(id)) { pushData(); return; }   // 非法值：下拉由载荷里的 preset 拉回
          currentPreset = id;                          // 选择即状态：不因拉取失败回滚
          savePreset(id);
          await refresh(id, 'range');                  // 失败也不弹窗，错误经面板横条呈现
        } else if (msg.type === 'setApiKey') {
          await promptApiKeyFlow();
        } else if (msg.type === 'openSettings') {
          // @ext:<id> 让设置页只显示本扩展的配置项；用运行时 id 以兼容任意 publisher
          vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + context.extension.id);
        }
      } catch (e) {
        vscode.window.showErrorMessage(tf('genericError', e.message || e));
      }
    });
    currentPanel.onDidDispose(() => { currentPanel = null; panelReady = false; });
  }

  // ---- Auto refresh ----
  // 间隔由设置 deepseek-usage-monitor.refreshInterval 决定（单位：分钟，0 = 关闭）
  let refreshTimer = null;
  function stopAutoRefresh() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }
  function startAutoRefresh() {
    stopAutoRefresh();
    const minutes = Number(config().get('refreshInterval', 1));
    if (!(minutes > 0)) return;
    refreshTimer = setInterval(() => refresh(undefined, 'auto'), minutes * 60 * 1000);
  }

  // ---- Set API Key flow（命令面板与面板按钮共用）----
  async function promptApiKeyFlow() {
    // 不 await secrets，避免 keyring 响应慢时阻塞输入框弹出；预填值取自缓存/配置
    const currentKey = apiKeyCache !== undefined ? (apiKeyCache || configApiKey()) : configApiKey();
    if (apiKeyCache === undefined) warmApiKey().catch(() => {});   // 后台读，不阻塞弹窗
    while (true) {
      const newKey = await vscode.window.showInputBox({ prompt: t().enterApiKey, placeHolder: 'sk-...', password: true, ignoreFocusOut: true, value: currentKey });
      if (newKey === undefined) return; // ESC：退出，不保存、不再弹
      const trimmed = newKey.trim();
      if (!trimmed) { vscode.window.showWarningMessage(t().errEmptyKey); continue; }
      if (!/^sk-.+/.test(trimmed)) { vscode.window.showWarningMessage(t().errKeyFormat); continue; }
      const persisted = await setApiKey(trimmed);
      if (persisted && keyDegraded) {
        // 已知密钥环不可用：写入只落在内存里，明确标注有效期
        vscode.window.showInformationMessage(t().keySavedSession);
      } else if (persisted) {
        vscode.window.showInformationMessage(t().keySaved);
      } else {
        keyDegraded = true;
        vscode.window.showWarningMessage(t().keyPersistFailed);
      }
      refresh(undefined, 'setApiKey');
      return;
    }
  }

  // ---- Commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek-usage-monitor.showUsage', () => openUsagePanel()),
    vscode.commands.registerCommand('deepseek-usage-monitor.refresh', () => refresh(undefined, 'command')),
    vscode.commands.registerCommand('deepseek-usage-monitor.setApiKey', () => promptApiKeyFlow()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('deepseek-usage-monitor')) return;
      if (e.affectsConfiguration('deepseek-usage-monitor.refreshInterval')) startAutoRefresh();
      if (e.affectsConfiguration('deepseek-usage-monitor.language') && currentPanel) rebuildShell();
      refresh(undefined, 'config');
    }),
    statusBarItem
  );

  // Init —— 首刷不阻塞 activate()：网络慢时会让扩展激活挂起数秒（请求超时上限 15s），状态栏先显示加载态即可
  refresh(undefined, 'init');
  // 自动刷新必须带上当前选中的月份，否则会把用户选的月份重置回当月
  startAutoRefresh();
  context.subscriptions.push({ dispose: stopAutoRefresh });
  console.log('[DeepSeek Usage Monitor] Activated');
}

function deactivate() { console.log('[DeepSeek Usage Monitor] Deactivated'); }
module.exports = { activate, deactivate, __test: {
  resolveRange, slotStartSec, visibleSlotCount, coversMonthToDate, bucketSecOf,
  aggregateUsageRange, fmtRangeLabel, RANGE_PRESET_DEFS, DEFAULT_PRESET,
} };
