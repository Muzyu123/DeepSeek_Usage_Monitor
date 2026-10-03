/*
 * DeepSeek Usage Monitor & Dashboard for VS Code
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
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 系统 keyring 缺失时（如 Linux 无 org.freedesktop.secrets）会造成进程阻塞
// 所以 secrets 读取一律带超时 + 内存缓存
const SECRETS_KEY = 'deepseek-usage-monitor.apiKey';
const PRESET_STATE_KEY = 'deepseekUsage.rangePreset';   // 面板时间窗口的持久化键
const SECRETS_TIMEOUT_MS = 2000; // 等待 secrets 响应超时的阈值，超时后降级为内存缓存并报错，API Key 只在本次会话有效

// 面板背景图：文件名存 globalState，文件本体存 globalStorage/background（详见 Dashboard Background 段）
const BG_IMAGE_KEY = 'deepseekUsage.bgImage';   // 存储名（含内容哈希），同时是 webview URL 的来源
const BG_LABEL_KEY = 'deepseekUsage.bgLabel';   // 用户原文件名，仅用于界面展示
const BG_DIR_NAME = 'background';
const BG_EXT_LIST = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const BG_MAX_BYTES = 5 * 1024 * 1024;   // 上限 5MB：webview 按解码后的位图驻留内存，过大影响面板响应
const BG_DIM_DEFAULT = 0.4;
const BG_DIM_MAX = 0.9;
const BG_CARD_OPACITY_DEFAULT = 0.82;   // 有背景时卡片底色不透明度；下限保证文字仍可读
const BG_CARD_OPACITY_MIN = 0.3;

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
    settings: '⚙ Settings', setApiKey: 'Set API Key', setBg: 'Set Background',
    menuTitle: 'Settings', menuOpenSettings: 'Open Settings',
    menuConfigTransfer: 'Migrate configuration',
    menuImport: 'Import configuration', menuExport: 'Export configuration',
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
    bgPickTitle: 'Select a background image',
    bgPathPrompt: 'Enter the absolute path of the image on the machine running the extension host',
    bgFileMissing: 'File not found: {0}',
    bgBadFormat: 'Unsupported image format: {0}',
    bgTooLarge: 'Image is too large ({0} MB); the limit is {1} MB',
    bgSet: 'Dashboard background image set',
    bgCleared: 'Dashboard background image cleared',
    bgPickActionTitle: 'Select an action',
    chartColorsBtn: 'Colors',
    colorModeLabel: 'Color mode',
    colorModeOfficial: 'Official palette',
    colorModeModel: 'Per model',
    colorModeMono: 'Auto shades',
    colorBaseLabel: 'Base color',
    colorClose: 'Close',
    exportConfigTitle: 'Export configuration',
    importConfigTitle: 'Select a configuration file to import',
    exportDone: 'Configuration exported: {0}',
    exportFailed: 'Export failed: {0}',
    importBadFile: 'Not a DeepSeek Usage Monitor configuration file',
    importBadVersion: 'Configuration version {0} is newer than this extension supports ({1})',
    importReadFailed: 'Failed to read the file: {0}',
    importNothing: 'Nothing to import in this file',
    importConfirmMsg: 'Import {0} setting(s) and {1} state item(s); {2} skipped. Existing values will be overwritten.',
    importConfirm: 'Apply',
    importApplied: 'Configuration imported: {0} setting(s), {1} state item(s)',
    importSkipped: 'Skipped {0} item(s): {1}',
    bgChangeOption: 'Change background image',
    bgClearOption: 'Clear background image',
    bgCurrentFile: 'Current: {0}',
    bgNoneSet: 'No background image set',
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
    settings: '⚙ 设置', setApiKey: '设置 API Key', setBg: '设置背景图',
    menuTitle: '设置', menuOpenSettings: '打开设置',
    menuConfigTransfer: '迁移配置',
    menuImport: '读取配置', menuExport: '导出配置',
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
    bgPickTitle: '选择背景图片',
    bgPathPrompt: '请输入图片在扩展宿主所在机器上的绝对路径',
    bgFileMissing: '文件不存在：{0}',
    bgBadFormat: '不支持的图片格式：{0}',
    bgTooLarge: '图片过大（{0} MB），上限 {1} MB',
    bgSet: '面板背景图已设置',
    bgCleared: '面板背景图已清除',
    bgPickActionTitle: '请选择操作',
    chartColorsBtn: '配色',
    colorModeLabel: '配色方式',
    colorModeOfficial: '官方色阶',
    colorModeModel: '按模型指定',
    colorModeMono: '单主色阶梯',
    colorBaseLabel: '主色',
    colorClose: '关闭',
    exportConfigTitle: '导出配置',
    importConfigTitle: '选择要读取的配置文件',
    exportDone: '配置已导出：{0}',
    exportFailed: '导出失败：{0}',
    importBadFile: '不是本扩展的配置文件',
    importBadVersion: '配置文件版本 {0} 高于当前扩展支持的版本（{1}）',
    importReadFailed: '读取文件失败：{0}',
    importNothing: '该文件中没有可导入的项',
    importConfirmMsg: '将导入：设置 {0} 项、状态 {1} 项；跳过 {2} 项。同名项会被覆盖。',
    importConfirm: '应用',
    importApplied: '配置已读取：设置 {0} 项、状态 {1} 项',
    importSkipped: '已跳过 {0} 项：{1}',
    bgChangeOption: '更换背景图',
    bgClearOption: '清空背景图',
    bgCurrentFile: '当前：{0}',
    bgNoneSet: '当前未设置背景图',
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
//  Dashboard Background
// ============================================================
//
// 背景有两个来源：设置项 dashboard.backgroundColor（纯色或渐变），以及命令选定的图片。
// 图片不引用用户原路径：复制进 globalStorage/background 后经 asWebviewUri 加载。
// 由此 localResourceRoots 只需该固定目录，原文件被移动或删除也不影响已设置的背景。

// 颜色/渐变白名单：字符集排除引号、分号、花括号、反斜杠、斜杠、冒号与 @，
// 因此该值不能逃出 style 块，也不能构造 url() 外链或 CSS 注释；函数另按名称排除。
// 设置值可能来自工作区 settings.json（他人仓库），校验不通过一律按未设置处理。
function sanitizeBgValue(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 200) return '';
  if (!/^[A-Za-z0-9#%.,()\s-]+$/.test(s)) return '';
  if (/\b(url|var|attr|expression|image-set)\s*\(/i.test(s)) return '';
  if (/^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([0-9\s.,%]+\)|hsla?\([0-9\s.,%]+\)|[a-z]{3,20})$/i.test(s)) return s;
  if (/^(linear|radial|conic)-gradient\((?:[^()]|\([^()]*\))+\)$/i.test(s)) return s;
  return '';
}

function bgDirPath(context) { return path.join(context.globalStorageUri.fsPath, BG_DIR_NAME); }

// 只保留基名，滤掉目录分隔符、控制字符与其它符号；Unicode 字母数字（含中文）保留，
// 否则 两个jpg文件会同时被抹成 __.jpg，落成同一个文件、同一个 webview URL
function bgSafeName(filePath) {
  const base = path.basename(String(filePath || ''))
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^\.+/, '');
  return Array.from(base).slice(0, 80).join('');   // 按码位截断，避免截断代理对
}

// 图片实际路径：未设置、文件名非法或文件已被删除时返回空串（面板按无背景渲染）
function bgImagePath(context) {
  const name = String(context.globalState.get(BG_IMAGE_KEY, '') || '');
  if (!/^[\p{L}\p{N}._-]{1,80}$/u.test(name) || /^\.+$/.test(name)) return '';   // 全点的名字（. / ..）不接受
  const p = path.join(bgDirPath(context), name);
  try { return fs.statSync(p).isFile() ? p : ''; } catch { return ''; }
}

// 清空背景目录中 keep 之外的文件（换图与清除共用；目录内其它文件删除失败不阻断流程）
function bgRemoveOthers(dir, keep) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (n === keep) continue;
    try { fs.unlinkSync(path.join(dir, n)); } catch { /* 保留不可删除的文件 */ }
  }
}

function resolveBackground(context, webview) {
  const cfg = vscode.workspace.getConfiguration('deepseek-usage-monitor');
  const color = sanitizeBgValue(cfg.get('dashboard.backgroundColor', ''));
  let dim = Number(cfg.get('dashboard.backgroundDim', BG_DIM_DEFAULT));
  if (!Number.isFinite(dim)) dim = BG_DIM_DEFAULT;
  dim = Math.round(Math.max(0, Math.min(BG_DIM_MAX, dim)) * 100) / 100;
  let cardOpacity = Number(cfg.get('dashboard.cardOpacity', BG_CARD_OPACITY_DEFAULT));
  if (!Number.isFinite(cardOpacity)) cardOpacity = BG_CARD_OPACITY_DEFAULT;
  cardOpacity = Math.round(Math.max(BG_CARD_OPACITY_MIN, Math.min(1, cardOpacity)) * 100) / 100;
  const file = bgImagePath(context);
  const image = file && webview ? String(webview.asWebviewUri(vscode.Uri.file(file))) : '';
  if (image) console.log('[DeepSeek Usage Monitor] background image:', path.basename(file));
  return { color, image, dim, cardOpacity };
}

// ============================================================
//  Chart Colors
// ============================================================
//
// 三种配色方式：官方色阶 / 按模型名指定 / 单主色自动阶梯，设定值存储于 globalState（与时间窗口、背景图一致）
// 颜色会进入面板的 style 属性与 canvas fillStyle，因此仍按 #RGB[A] / #RRGGBB[AA] 校验后使用
// 模型名到颜色的最终映射只在宿主计算（chartColorMap），面板查表，避免重复计算

const CHART_COLOR_MODES = ['official', 'model', 'mono'];
const CHART_STATE_KEYS = {
  mode: 'deepseekUsage.chartColorMode',
  modelColors: 'deepseekUsage.chartModelColors',
  baseColor: 'deepseekUsage.chartBaseColor',
};
const CHART_COLOR_DEFAULT = '#FFAA00';   // 官方色阶首色，同时作为单主色模式的默认主色
const OFFICIAL_COST_COLORS = ['#FFAA00', '#FF8800', '#FF5500', '#FFCC66', '#CC4400', '#994400'];

function sanitizeChartColor(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) ? s : '';
}

// hex → [hue, saturation, lightness]，无法解析返回 null
function hexToHsl(hex) {
  const s = sanitizeChartColor(hex);
  if (!s) return null;
  const h = s.slice(1);
  let r, g, b;
  if (h.length === 3 || h.length === 4) {
    r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16);
  } else {
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  }
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return [0, 0, l];
  let hue = max === R ? ((G - B) / d) % 6 : (max === G ? (B - R) / d + 2 : (R - G) / d + 4);
  hue *= 60;
  if (hue < 0) hue += 360;
  return [hue, d / (1 - Math.abs(2 * l - 1)), l];
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

// 单主色阶梯：保持色相与饱和度，按模型数量在明度上均匀铺开（与官方色阶同向：越靠后越深）
function colorLadder(base, count) {
  const hsl = hexToHsl(base);
  if (!hsl || !(count > 0)) return [];
  const l1 = Math.min(0.78, hsl[2] + 0.16);
  const l2 = Math.max(0.22, hsl[2] - 0.24);
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.3 : i / (count - 1);
    out.push(hslToHex(hsl[0], hsl[1], l1 + (l2 - l1) * t));
  }
  return out;
}

function resolveChartConfig(context) {
  const gs = context.globalState;
  const modeRaw = String(gs.get(CHART_STATE_KEYS.mode, '') || '');
  const mode = CHART_COLOR_MODES.indexOf(modeRaw) >= 0 ? modeRaw : 'official';
  const rawMap = gs.get(CHART_STATE_KEYS.modelColors, {});
  const modelColors = {};
  if (rawMap && typeof rawMap === 'object') {
    for (const key of Object.keys(rawMap)) {
      const c = sanitizeChartColor(rawMap[key]);
      if (c) modelColors[String(key)] = c;
    }
  }
  return { mode, modelColors, baseColor: sanitizeChartColor(gs.get(CHART_STATE_KEYS.baseColor, '')) || CHART_COLOR_DEFAULT };
}

// 模型名 → 颜色。单一主色或按模型指定时未覆盖的模型回落到官方色阶
function chartColorMap(context, models) {
  const cfg = resolveChartConfig(context);
  const list = Array.isArray(models) ? models : [];
  const ladder = cfg.mode === 'mono' ? colorLadder(cfg.baseColor, list.length) : [];
  const map = {};
  list.forEach((name, i) => {
    if (cfg.mode === 'model' && cfg.modelColors[name]) map[name] = cfg.modelColors[name];
    else if (cfg.mode === 'mono' && ladder[i]) map[name] = ladder[i];
    else map[name] = OFFICIAL_COST_COLORS[i % OFFICIAL_COST_COLORS.length];
  });
  return map;
}

// ============================================================
//  Config Export / Import
// ============================================================
//
// 导出「外观与行为」：设置里除凭证外的项 + 面板状态（时间窗口、图表配色）
// sessionToken、cookie 与 API Key（SecretStorage）以及背景图文件不内嵌
// 读取是纯数据路径：按白名单逐项校验，未识别的键与非法值一律跳过并汇报
// 因此他人配置文件不能借导入写入任意设置（例如把 proxy 指向别处）

const CONFIG_FILE_APP = 'deepseek-usage-monitor';
const CONFIG_FILE_VERSION = 1;
const CONFIG_SETTING_KEYS = [
  'language', 'statusBar.items', 'statusBar.label', 'statusBar.closeWhenActive', 'refreshInterval',
  'dashboard.backgroundColor', 'dashboard.backgroundDim',
];
const CONFIG_STATE_KEYS = [PRESET_STATE_KEY, CHART_STATE_KEYS.mode, CHART_STATE_KEYS.modelColors, CHART_STATE_KEYS.baseColor];
const SB_ITEM_IDS = ['todayCost', 'monthCost', 'balance', 'todayTokens'];
const SB_LABEL_DEFAULT = 'DeepSeek Usage';   // 状态栏显示的名称；可由 statusBar.label 覆盖，留空则不显示
const SB_LABEL_MAX = 64;                     // 名称长度上限（防止把状态栏挤爆；配置导入时也按此校验）
const CONFIG_NOT_EXPORTED = [
  'deepseek-usage-monitor.sessionToken',
  'deepseek-usage-monitor.cookie',
  'API Key (SecretStorage)',
  'background image file',
];

// 设置项白名单校验：返回 undefined 表示不可导入
function sanitizeConfigSetting(shortKey, value) {
  switch (shortKey) {
    case 'language':
      return (value === 'en' || value === 'zh-cn') ? value : undefined;
    case 'statusBar.items': {
      if (!Array.isArray(value)) return undefined;
      return Array.from(new Set(value.filter((v) => SB_ITEM_IDS.indexOf(v) >= 0)));
    }
    case 'statusBar.label': {
      const s = String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim();
      return s.length > SB_LABEL_MAX ? undefined : s;   // 空串合法（= 不显示名称）
    }
    case 'statusBar.closeWhenActive':
      return typeof value === 'boolean' ? value : undefined;   // 只接受真正的布尔值
    case 'refreshInterval': {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 && n <= 1440 ? n : undefined;
    }
    case 'dashboard.backgroundColor': {
      const s = sanitizeBgValue(value);
      return (s === '' && String(value == null ? '' : value).trim() === '') ? '' : (s || undefined);
    }
    case 'dashboard.backgroundDim': {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 && n <= BG_DIM_MAX ? Math.round(n * 100) / 100 : undefined;
    }
    default:
      return undefined;
  }
}

function sanitizeConfigState(key, value) {
  if (key === PRESET_STATE_KEY) return isPreset(String(value || '')) ? String(value) : undefined;
  if (key === CHART_STATE_KEYS.mode) return CHART_COLOR_MODES.indexOf(String(value)) >= 0 ? String(value) : undefined;
  if (key === CHART_STATE_KEYS.baseColor) return sanitizeChartColor(value) || undefined;
  if (key === CHART_STATE_KEYS.modelColors) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    for (const k of Object.keys(value)) {
      const c = sanitizeChartColor(value[k]);
      if (c) out[String(k)] = c;
    }
    return out;
  }
  return undefined;
}

// ============================================================
//  Webview HTML Generator — Canvas Charts Dashboard
// ============================================================
//
// 数据不再拼进 HTML，只有面板创建和语言变化时才重建外壳，其余一律通过 postMessage 推送数据


function buildPanelHtml(i18n, langCode, selectedPreset, bg) {
  const rangeOpts = RANGE_PRESET_DEFS
    .map((d) => `<option value="${d.id}"${d.id === selectedPreset ? ' selected' : ''}>${i18n[d.key]}</option>`).join('');
  const rangeIds = JSON.stringify(RANGE_PRESET_DEFS.map((d) => d.id));
  const htmlLang = langCode === 'en' ? 'en' : 'zh-CN';   // <html lang> 跟随语言设置

  // 背景规则统一追加在 style 末尾：同特异性下后者生效，用于覆盖上面的 body 与 .card 底色
  const bgImage = bg && bg.image ? String(bg.image) : '';
  const bgColor = bg && bg.color ? String(bg.color) : '';
  const bgDim = bg && Number.isFinite(bg.dim) ? bg.dim : BG_DIM_DEFAULT;
  const bgRules = [];
  if (bgImage) {
    // 图片层与暗化层用 fixed 伪元素铺满视口；z-index 为负，位于内容之下
    bgRules.push(
      'body{background:transparent}',
      `body::before{content:'';position:fixed;inset:0;z-index:-2;background-image:url("${bgImage}");background-size:cover;background-position:center;background-repeat:no-repeat}`,
      `body::after{content:'';position:fixed;inset:0;z-index:-1;background:rgba(0,0,0,${bgDim})}`,
      `body.vscode-light::after{background:rgba(255,255,255,${bgDim})}`,
    );
  } else if (bgColor) {
    bgRules.push(`body{background:${bgColor}}`);
  }
  if (bgImage || bgColor) {
    // 卡片转半透明让背景透出，透明度可配；高对比度主题不覆盖 --ds-card-bg，保持不透明。
    // 浅色主题比深色略高一点（默认 0.82 → 0.88），白底上文字对比度更稳
    const op = bg && Number.isFinite(bg.cardOpacity) ? bg.cardOpacity : BG_CARD_OPACITY_DEFAULT;
    const opLight = Math.round(Math.min(1, op + 0.06) * 100) / 100;
    bgRules.push(
      `body.vscode-dark{--ds-card-bg:rgba(30,32,36,${op})}`,
      `body.vscode-light{--ds-card-bg:rgba(255,255,255,${opLight})}`,
    );
  }
  const bgCss = bgRules.length ? '\n/* dashboard background */\n' + bgRules.join('\n') + '\n' : '';

  return `<!DOCTYPE html><html lang="${htmlLang}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${i18n.title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);padding:20px 24px;font-size:13px}
h1{font-size:18px;font-weight:600}
.subtitle{font-size:11px;color:var(--vscode-editor-foreground);margin-top:4px;margin-bottom:16px}
.banner{margin-bottom:12px;padding:8px 12px;border-radius:6px;font-size:12px;background:var(--vscode-inputValidation-errorBackground,rgba(241,76,76,.12));border:1px solid var(--vscode-inputValidation-errorBorder,#f14c4c)}
.banner[hidden]{display:none}
.border{--card-border:var(--vscode-widget-border,rgba(128,128,128,.25))}
.cards-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.cards-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.card{background:var(--ds-card-bg,var(--vscode-editorWidget-background,var(--vscode-input-background)));border:1px solid var(--vscode-widget-border,rgba(128,128,128,.25));border-radius:6px;padding:14px 16px;min-width:0}
.card-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.card .label{font-size:11px;color:var(--vscode-editor-foreground);margin-bottom:6px}
.card .value{display:inline-block;font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.card .suffix{font-size:11px;color:var(--vscode-descriptionForeground);margin-left:6px}
.card .suffix[hidden]{display:none}
.card .sub{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px}
.card .sub[hidden]{display:none}
.divider{border:none;border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.25));margin:18px 0 16px}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
.toolbar-l{display:flex;align-items:center;gap:8px}
.toolbar-label{font-size:12px;color:var(--vscode-editor-foreground)}
.toolbar-r{display:flex;align-items:center;gap:10px}
.updated-at{font-size:11px;color:var(--vscode-editor-foreground);white-space:nowrap}
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
#chart-tip{position:fixed;pointer-events:none;z-index:998;background:var(--ds-card-bg,var(--vscode-editorWidget-background,var(--vscode-input-background)));color:var(--vscode-editor-foreground);border:1px solid var(--vscode-widget-border,rgba(128,128,128,.25));border-radius:6px;padding:10px 14px;font-size:11px;line-height:1.6;box-shadow:0 4px 12px rgba(0,0,0,.3);opacity:0;transition:opacity .15s;max-width:300px}
#chart-tip.show{opacity:1}
#chart-tip .tip-row{display:flex;justify-content:space-between;gap:18px;white-space:nowrap}
#chart-tip .tip-row span:last-child{font-variant-numeric:tabular-nums}
#chart-tip .tip-head{font-weight:600;padding-bottom:5px;margin-bottom:5px;border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.25))}
#chart-tip .tip-dot{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:6px;vertical-align:middle}
.chart-card{position:relative}
.chart-card .card-head{padding-right:78px}   /* 给右上角的「配色」按钮让位，图例不会压到它 */
.chart-card #colorBtn{position:absolute;top:12px;right:14px}
.color-panel{position:fixed;z-index:997;right:24px;top:56px;width:252px;padding:12px 14px;border-radius:6px;background:var(--ds-card-bg,var(--vscode-editorWidget-background,var(--vscode-input-background)));border:1px solid var(--vscode-widget-border,rgba(128,128,128,.25));box-shadow:0 6px 18px rgba(0,0,0,.35)}
.color-panel[hidden]{display:none}
.cp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.cp-title{font-size:12px;font-weight:600}
.cp-close{padding:0 4px;border:none;background:none;color:var(--vscode-descriptionForeground);cursor:pointer;font-size:12px;line-height:1}
.cp-close:hover{color:var(--vscode-editor-foreground)}
.cp-row{display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:6px}
.cp-row input[type=color]{width:30px;height:20px;padding:0;border:1px solid var(--vscode-widget-border,rgba(128,128,128,.25));border-radius:3px;background:none;cursor:pointer}
.cp-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.head-actions{display:flex;align-items:center;gap:8px}
${bgCss}</style></head>
<body><div id="toast"></div><div id="chart-tip"></div>

<div class="panel-head">
  <h1>${i18n.usageTitle}</h1>
  <div class="head-actions">
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

<div class="card chart-card" style="margin-top:12px">
  <div class="card-head">
    <div class="chart-title">${i18n.costCny}<span class="chart-total" id="chartTotal"></span></div>
    <div class="legend" id="costLegend"></div>
  </div>
  <div class="chart-wrap" id="costWrap"><canvas id="costChart" style="width:100%;height:260px"></canvas></div>
  <button class="btn btn-light" id="colorBtn">${i18n.chartColorsBtn}</button>
</div>

<div class="color-panel" id="colorPanel" hidden></div>

<script>
(function() {
const vsc = acquireVsCodeApi();
// 固定文案仅重建外壳时更新；运行期动态文案随数据一起推送更新
var I18N = ${JSON.stringify(i18n).replace(/</g, '\\u003c')};
var RANGE_IDS = ${rangeIds};
var D = null;                 // 最近一次由扩展推送的数据
var busySafety = null;        // 刷新按钮的兜底解锁计时器

// 官方「消费金额」柱状图色阶（截图像素采样），由宿主注入；用于 D.colors 未覆盖的模型
var COST_COLORS = ${JSON.stringify(OFFICIAL_COST_COLORS)};

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
// 颜色由宿主按配色设置算好（D.colors，已校验为 #hex）；缺失时回落官方色阶，避免出现 undefined
function colorOf(model) {
  var map = (D && D.colors) || {};
  if (map[model]) return map[model];
  var i = modelOrder().indexOf(model);
  return COST_COLORS[(i >= 0 ? i : COST_COLORS.length - 1) % COST_COLORS.length];
}

// 配色设置：宿主已校验并算好最终颜色，这里只读
function chartCfg() { return (D && D.chart) || { mode: 'official', modelColors: {}, baseColor: COST_COLORS[0] }; }

// input[type=color] 只接受 #rrggbb；把 3/4 位简写补全，带 alpha 的丢掉 alpha
function toColorInput(v) {
  var s = String(v || '');
  if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  if (/^#[0-9a-f]{4}$/i.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  if (/^#[0-9a-f]{8}$/i.test(s)) return s.slice(0, 7);
  return /^#[0-9a-f]{6}$/i.test(s) ? s : COST_COLORS[0];
}

// 配色浮层：模式三选 +（按模型指定时）每个模型一个取色器 + 主色 + 恢复官方。
// 元素逐个 createElement 并绑事件（面板无 CSP nonce，不使用内联 onclick）
function renderColorPanel() {
  var el = document.getElementById('colorPanel'); if (!el) return;
  var L = i18n(), cfg = chartCfg();
  el.innerHTML = '';

  var head = document.createElement('div'); head.className = 'cp-head';
  var title = document.createElement('div');
  title.className = 'cp-title'; title.textContent = L.colorModeLabel;
  var close = document.createElement('button');
  close.className = 'cp-close'; close.textContent = '✕'; close.title = L.colorClose;
  close.addEventListener('click', function() { el.hidden = true; });
  head.appendChild(title); head.appendChild(close); el.appendChild(head);

  [['official', L.colorModeOfficial], ['model', L.colorModeModel], ['mono', L.colorModeMono]].forEach(function(m) {
    var row = document.createElement('label'); row.className = 'cp-row';
    var radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'cpMode'; radio.value = m[0]; radio.checked = cfg.mode === m[0];
    radio.addEventListener('change', function() { if (radio.checked) post('setChartColors', { mode: m[0] }); });
    var name = document.createElement('span'); name.textContent = m[1];
    row.appendChild(radio); row.appendChild(name); el.appendChild(row);
  });

  if (cfg.mode === 'model') {
    modelOrder().forEach(function(model) {
      var row = document.createElement('label'); row.className = 'cp-row';
      var picker = document.createElement('input');
      picker.type = 'color'; picker.className = 'cp-color'; picker.value = toColorInput(colorOf(model));
      picker.addEventListener('change', function() { post('setChartColors', { model: model, color: picker.value }); });
      var name = document.createElement('span'); name.className = 'cp-name'; name.textContent = model;
      row.appendChild(picker); row.appendChild(name); el.appendChild(row);
    });
  } else if (cfg.mode === 'mono') {
    var row2 = document.createElement('label'); row2.className = 'cp-row';
    var base = document.createElement('input');
    base.type = 'color'; base.value = toColorInput(cfg.baseColor);
    base.addEventListener('change', function() { post('setChartColors', { color: base.value }); });
    var baseName = document.createElement('span'); baseName.textContent = L.colorBaseLabel;
    row2.appendChild(base); row2.appendChild(baseName); el.appendChild(row2);
  }
}

// Toast
var toastTimer = null;
function toast(msg) { var e = document.getElementById('toast'); e.textContent = msg; e.className = 'show'; clearTimeout(toastTimer); toastTimer = setTimeout(function() { e.className = ''; }, 2000); }

// Theme-aware grid color（仅用于网格/参考线）
function gridColor() {
  var bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
  var v = parseInt(bg.replace('#', ''), 16);
  if (isNaN(v)) return '#888';
  return v < 0x888888 ? '#444' : '#ddd';
}

// 图上的文字（轴刻度、空态提示）用主题前景色，与面板正文一致；
// 与 gridColor 分开，避免"文字和网格线同色"导致的偏灰
function labelColor() {
  return getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground').trim() || '#ccc';
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
  ctx.fillStyle = labelColor(); ctx.font = '12px sans-serif';
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
      ctx.fillStyle = labelColor(); ctx.textAlign = 'right';
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

    // x 轴刻度：柱数 < 4 时全部显示，否则最多 4 个 —— 在首末之间均匀取点（首末必有），单行标注。
    // 上限再受可用宽度约束，避免面板很窄时几个日期挤在一起
    var maxLabels = Math.max(2, Math.min(4, Math.floor(pw / 110)));
    var count = Math.min(n, maxLabels);
    var idxs = [];
    for (var li = 0; li < count; li++) {
      var ix2 = count === 1 ? 0 : Math.round(li * (n - 1) / (count - 1));
      if (idxs.indexOf(ix2) < 0) idxs.push(ix2);
    }
    ctx.textAlign = 'center'; ctx.fillStyle = labelColor(); ctx.font = '10px sans-serif';
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
    setText('topupSub', subs.join(' · '));          // 无内容时不占位（见 .sub[hidden]）
    show('topupSub', subs.length > 0);
  } else {
    setText('topupValue', '—'); show('topupSuffix', false);
    setText('topupSub', d.keyDegraded ? (L.errNoApiKey + ' · ' + L.keySessionOnly) : L.errNoApiKey);
    show('topupSub', true);
  }

  // 卡B：今日消费（始终表示今天，与图表所选窗口无关）
  if (d.hasToday) {
    setText('todayValue', '¥' + fmtCost(d.todayCost)); show('todaySuffix', true);
    setText('todaySub', ''); show('todaySub', false);   // 无内容时不占位
  } else {
    setText('todayValue', '—'); show('todaySuffix', false);
    setText('todaySub', !d.hasCreds ? L.noSessionToken : L.loadFailed);
    show('todaySub', true);
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
  var cp = document.getElementById('colorPanel');
  if (cp && !cp.hidden) renderColorPanel();   // 浮层打开时跟随最新配色刷新
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
document.getElementById('colorBtn').addEventListener('click', function() {
  var el = document.getElementById('colorPanel'); if (!el) return;
  if (el.hidden) {
    renderColorPanel();
    // 浮层贴着按钮展开（按钮在图表卡右上角，位置随窗口宽度变化）
    var r = this.getBoundingClientRect();
    el.style.top = Math.round(r.bottom + 6) + 'px';
    el.style.right = Math.max(12, Math.round(window.innerWidth - r.right)) + 'px';
    el.hidden = false;
  } else { el.hidden = true; }
});
document.getElementById('settingsBtn').addEventListener('click', function() {
  post('openMenu');   // 入口菜单在宿主侧用 QuickPick 展开
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
  // 状态栏点击的行为由 statusBar.closeWhenActive 决定；命令面板的「打开面板」始终只开/聚焦
  statusBarItem.command = { command: 'deepseek-usage-monitor.statusBarClick', title: i18n.title };
  statusBarItem.text = statusText('$(sync~spin)');   // 加载态；名称已按 statusBar.label 取
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
      return { totalCost: monthAgg.totalCost, todayCost: bar ? bar.cost : 0, todayTokens: bar ? bar.tokens : 0 };
    }
    if (!windowAgg) return null;
    if (coversMonthToDate(spec, now)) {
      const bar = lastOf(windowAgg);
      return { totalCost: windowAgg.totalCost, todayCost: bar ? bar.cost : 0, todayTokens: bar ? bar.tokens : 0 };
    }
    if (spec.id === 'today') {
      return { totalCost: null, todayCost: windowAgg.totalCost, todayTokens: windowAgg.totalTokens };
    }
    if (spec.granularity === 'day') {
      const bar = lastOf(windowAgg);
      if (bar && bar.date === todayDate) return { totalCost: null, todayCost: bar.cost, todayTokens: bar.tokens };
    }
    return { totalCost: null, todayCost: null, todayTokens: null };
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

  // 状态栏里的名称部分（默认 DeepSeek Usage，可由 statusBar.label 覆盖为任意文本）。
  // 去掉换行与制表符：状态栏是单行文本，换行会把图标与数据挤到第二行；
  // 允许留空 —— 此时只显示图标与数据，不显示名称。
  function statusLabel() {
    const raw = config().get('statusBar.label', SB_LABEL_DEFAULT);
    return String(raw == null ? '' : raw).replace(/[\r\n\t]+/g, ' ').trim();
  }

  // 拼状态栏文本：[图标, 名称, 数据] 中为空的部分自动省略，避免多余空格
  function statusText(icon, rest) {
    return [icon, statusLabel(), rest].filter(Boolean).join(' ');
  }

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
    if (error) { statusBarItem.text = statusText('$(error)'); statusBarItem.tooltip = errorText ? `${errorText}\n(${error})` : error; statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground'); return; }
    const bal = balance?.balance_infos?.[0]; const balTotal = bal ? parseFloat(bal.total_balance).toFixed(2) : null;
    // 状态栏的"本月/本日"恒为当前月与今天，与面板所选窗口无关
    const cost = month && month.totalCost != null ? month.totalCost.toFixed(2) : null;
    const today = month && month.todayCost != null ? month.todayCost.toFixed(2) : null;
    const todayTokens = month && month.todayTokens != null ? month.todayTokens : null;

    // 未配置任何凭证时保留引导，避免状态栏显示一长串 —
    if (!balTotal && !month && !usage) {
      statusBarItem.text = statusText('$(key)');
      statusBarItem.tooltip = keyDegraded ? `${t().errNoApiKey}\n${t().keySessionOnly}` : t().errNoApiKey;
      statusBarItem.backgroundColor = undefined;
      return;
    }

    const segs = buildStatusSegments({ today, cost, balTotal, todayTokens });
    statusBarItem.text = statusText('$(credit-card)', segs.length ? segs.join(' | ') : '');
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
      chart: resolveChartConfig(context),                                        // 面板配色控件用（模式/主色/按模型覆盖）
      colors: chartColorMap(context, usage ? usage.models.map((m) => m.model) : []), // 已解析的最终颜色，面板只查表
      totalCost: usage ? usage.totalCost : 0, totalTokens: usage ? usage.totalTokens : 0, totalReqs: usage ? usage.totalReqs : 0,
      monthCost: month ? month.totalCost : null,    // 与窗口无关
      hasToday: !!(month && month.todayCost != null),
      todayCost: month ? month.todayCost : null, todayTokens: month ? month.todayTokens : null,
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
    currentPanel.webview.html = buildPanelHtml(t(), langKey(), currentPreset, resolveBackground(context, currentPanel.webview));
  }

  // 状态栏点击：默认只打开/聚焦（statusBar.closeWhenActive = false）；
  // 打开该开关后，面板在前台时再点即关闭。
  function onStatusBarClick() {
    if (config().get('statusBar.closeWhenActive', false) === true) toggleUsagePanel();
    else openUsagePanel();
  }

  // 只在"前台"时关闭，避免面板可见但未聚焦（例如被切到别的编辑器组）时被误关
  function toggleUsagePanel() {
    if (currentPanel && currentPanel.visible && currentPanel.active) { currentPanel.dispose(); return; }
    openUsagePanel();
  }

  function openUsagePanel() {
    if (currentPanel) {
      currentPanel.reveal();
      if (panelLang !== langKey()) rebuildShell(); else pushData();
      return;
    }
    // 背景图目录先落盘：localResourceRoots 指向它，面板只允许加载该目录内的资源
    try { fs.mkdirSync(bgDirPath(context), { recursive: true }); } catch (e) { /* 目录创建失败时面板按无背景渲染 */ }
    currentPanel = vscode.window.createWebviewPanel('deepseekUsage', t().title, vscode.ViewColumn.Two, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(bgDirPath(context))],
    });
    panelReady = false; panelLang = langKey();
    // 外壳只在这里（以及语言/背景变化时）设置一次
    currentPanel.webview.html = buildPanelHtml(t(), langKey(), currentPreset, resolveBackground(context, currentPanel.webview));

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
        } else if (msg.type === 'openMenu') {
          await promptMainMenu();                  // 面板唯一入口：菜单里再分发到各流程
        } else if (msg.type === 'setChartColors') {
          await applyChartColors(msg);             // 只改渲染，不重取数据
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

  // ---- Dashboard background ----
  // 图片复制进 globalStorage/background 后经 asWebviewUri 加载：localResourceRoots 只需该目录，
  // 原文件被移动或删除不影响已设置的背景，也不读取用户路径之外的资源
  async function setDashboardBackground() {
    let picked;
    try {
      picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: t().bgPickTitle,
        filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
      });
    } catch (e) { picked = undefined; }
    if (!picked || !picked.length) return;

    let srcPath = String(picked[0].fsPath || '');
    if (!fs.existsSync(srcPath)) {
      // 远程窗口中对话框浏览的是客户端文件系统，宿主侧无此文件：改为输入宿主侧路径
      const typed = await vscode.window.showInputBox({ prompt: t().bgPathPrompt, value: srcPath, ignoreFocusOut: true });
      if (typed === undefined) return;
      srcPath = typed.trim();
      if (!srcPath) return;
      if (!fs.existsSync(srcPath)) { vscode.window.showErrorMessage(tf('bgFileMissing', srcPath)); return; }
    }

    const ext = path.extname(srcPath).toLowerCase();
    if (BG_EXT_LIST.indexOf(ext) < 0) { vscode.window.showWarningMessage(tf('bgBadFormat', BG_EXT_LIST.join(' '))); return; }

    let size = 0;
    try {
      const st = fs.statSync(srcPath);
      if (!st.isFile()) throw new Error('not a regular file');
      size = st.size;
    } catch (e) { vscode.window.showErrorMessage(tf('bgFileMissing', srcPath)); return; }
    if (size > BG_MAX_BYTES) {
      vscode.window.showWarningMessage(tf('bgTooLarge', (size / 1048576).toFixed(1), String(BG_MAX_BYTES / 1048576)));
      return;
    }

    // 存储名 = 基名 + 内容哈希：webview 按 URL 缓存资源，URL 必须随内容变化，
    // 否则更换同名图片会继续显示旧图
    let hash = '';
    try { hash = crypto.createHash('sha256').update(fs.readFileSync(srcPath)).digest('hex').slice(0, 8); }
    catch (e) { hash = Date.now().toString(16).slice(-8); }   // 读取失败时退化为时间戳，URL 仍随每次设置变化
    const raw = bgSafeName(srcPath);
    const stem = Array.from(!raw || raw.lastIndexOf('.') <= 0 ? 'background' : raw.slice(0, raw.lastIndexOf('.')))
      .slice(0, 60).join('');                                 // 60 + 1 + 8 + 后缀，落在 80 字上限内
    const name = stem + '-' + hash + ext;
    try {
      const dir = bgDirPath(context);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(srcPath, path.join(dir, name));
      bgRemoveOthers(dir, name);
    } catch (e) {
      vscode.window.showErrorMessage(tf('genericError', e.message || e));
      return;
    }
    await context.globalState.update(BG_IMAGE_KEY, name);
    await context.globalState.update(BG_LABEL_KEY, path.basename(srcPath));
    rebuildShell();
    vscode.window.showInformationMessage(t().bgSet);
  }

  async function clearDashboardBackground() {
    try { bgRemoveOthers(bgDirPath(context), ''); } catch (e) { /* globalStorage 不可用时仍清除状态，避免面板指向已失效的图片 */ }
    await context.globalState.update(BG_IMAGE_KEY, '');
    await context.globalState.update(BG_LABEL_KEY, '');
    rebuildShell();
    vscode.window.showInformationMessage(t().bgCleared);
  }

  // 面板「设置背景图」按钮：先选操作再执行。命令面板的两个命令保持直达，不加这一层。
  async function promptBackgroundAction() {
    const current = bgImagePath(context);
    const label = String(context.globalState.get(BG_LABEL_KEY, '') || '');
    const items = [
      { id: 'change', label: t().bgChangeOption, description: current ? tf('bgCurrentFile', label || path.basename(current)) : t().bgNoneSet },
      { id: 'clear', label: t().bgClearOption },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: t().bgPickActionTitle, ignoreFocusOut: true });
    if (!picked) return;
    if (picked.id === 'change') await setDashboardBackground();
    else if (picked.id === 'clear') await clearDashboardBackground();
  }

  // ---- Chart colors ----
  // 面板配色控件写回 globalState。只影响渲染：不重建外壳、不重取数据。
  // 指定单个模型的颜色即隐含切到「按模型指定」，否则界面上看不到变化。
  async function applyChartColors(msg) {
    const gs = context.globalState;
    const mode = String(msg.mode || '');
    if (CHART_COLOR_MODES.indexOf(mode) >= 0) await gs.update(CHART_STATE_KEYS.mode, mode);
    const color = sanitizeChartColor(msg.color);
    if (color && msg.model) {
      const map = Object.assign({}, gs.get(CHART_STATE_KEYS.modelColors, {}) || {});
      map[String(msg.model)] = color;
      await gs.update(CHART_STATE_KEYS.modelColors, map);
      if (String(gs.get(CHART_STATE_KEYS.mode, '') || '') !== 'model') await gs.update(CHART_STATE_KEYS.mode, 'model');
    } else if (color) {
      await gs.update(CHART_STATE_KEYS.baseColor, color);
    }
    pushData();
  }

  // ---- 面板入口菜单 ----
  // 面板只保留一个「⚙ 设置」按钮：背景图、API Key、迁移配置文件都从这里进入
  // 命令面板里的各条独立命令保持不变（两处入口共用同一批流程）
  async function promptMainMenu() {
    const items = [
      { id: 'settings', label: t().menuOpenSettings },
      { id: 'background', label: t().setBg },
      { id: 'apiKey', label: t().setApiKey },
      { id: 'config', label: t().menuConfigTransfer },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: t().menuTitle, ignoreFocusOut: true });
    if (!picked) return;
    if (picked.id === 'settings') {
      // @ext:<id> 让设置页只显示本扩展的配置项；用运行时 id 以兼容任意 publisher
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + context.extension.id);
    } else if (picked.id === 'background') {
      await promptBackgroundAction();
    } else if (picked.id === 'apiKey') {
      await promptApiKeyFlow();
    } else if (picked.id === 'config') {
      await promptConfigTransfer();
    }
  }

  // 导入 / 导出：与「更换 / 清空背景图」同为两级选择
  async function promptConfigTransfer() {
    const items = [
      { id: 'export', label: t().menuExport },
      { id: 'import', label: t().menuImport },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: t().menuConfigTransfer, ignoreFocusOut: true });
    if (!picked) return;
    if (picked.id === 'export') await exportConfig();
    else if (picked.id === 'import') await importConfig();
  }

  // ---- Config export / import ----
  async function exportConfig() {
    const settings = {};
    for (const short of CONFIG_SETTING_KEYS) {
      const v = config().get(short);
      if (v !== undefined) settings['deepseek-usage-monitor.' + short] = v;
    }
    const state = {};
    for (const key of CONFIG_STATE_KEYS) {
      const v = context.globalState.get(key, undefined);
      if (v !== undefined) state[key] = v;
    }
    let target;
    try {
      const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      target = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder.uri, 'deepseek-usage-config.json') : undefined,
        filters: { JSON: ['json'] },
        saveLabel: t().exportConfigTitle,
      });
    } catch (e) { target = undefined; }
    if (!target) return;
    const payload = {
      app: CONFIG_FILE_APP,
      version: CONFIG_FILE_VERSION,
      exportedAt: new Date().toISOString(),
      settings,
      state,
      notExported: CONFIG_NOT_EXPORTED,   // 文件自身说明范围，避免误以为含凭证
    };
    try {
      fs.writeFileSync(target.fsPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    } catch (e) {
      vscode.window.showErrorMessage(tf('exportFailed', e.message || e));
      return;
    }
    vscode.window.showInformationMessage(tf('exportDone', path.basename(target.fsPath)));
  }

  async function importConfig() {
    let picked;
    try {
      picked = await vscode.window.showOpenDialog({
        canSelectMany: false, openLabel: t().importConfigTitle, filters: { JSON: ['json'] },
      });
    } catch (e) { picked = undefined; }
    if (!picked || !picked.length) return;

    const file = String(picked[0].fsPath || '');
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      vscode.window.showErrorMessage(e && e.code ? tf('importReadFailed', e.message || e) : t().importBadFile);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || parsed.app !== CONFIG_FILE_APP) {
      vscode.window.showErrorMessage(t().importBadFile);
      return;
    }
    const ver = Number(parsed.version);
    if (!Number.isFinite(ver) || ver < 1) { vscode.window.showErrorMessage(t().importBadFile); return; }
    if (ver > CONFIG_FILE_VERSION) {
      vscode.window.showErrorMessage(tf('importBadVersion', ver, CONFIG_FILE_VERSION));
      return;
    }

    const prefix = 'deepseek-usage-monitor.';
    const apply = {}; const stateApply = {}; const skipped = [];
    const rawSettings = (parsed.settings && typeof parsed.settings === 'object') ? parsed.settings : {};
    for (const fullKey of Object.keys(rawSettings)) {
      const short = fullKey.indexOf(prefix) === 0 ? fullKey.slice(prefix.length) : '';
      // 凭证（sessionToken/cookie）、proxy 与未知键都在这里被block：白名单之外不写入
      if (!short || CONFIG_SETTING_KEYS.indexOf(short) < 0) { skipped.push(fullKey); continue; }
      const v = sanitizeConfigSetting(short, rawSettings[fullKey]);
      if (v === undefined) { skipped.push(fullKey); continue; }
      apply[short] = v;
    }
    const rawState = (parsed.state && typeof parsed.state === 'object') ? parsed.state : {};
    for (const key of Object.keys(rawState)) {
      if (CONFIG_STATE_KEYS.indexOf(key) < 0) { skipped.push(key); continue; }
      const v = sanitizeConfigState(key, rawState[key]);
      if (v === undefined) { skipped.push(key); continue; }
      stateApply[key] = v;
    }

    const nSettings = Object.keys(apply).length;
    const nState = Object.keys(stateApply).length;
    if (!nSettings && !nState) { vscode.window.showWarningMessage(t().importNothing); return; }
    const confirmed = await vscode.window.showWarningMessage(
      tf('importConfirmMsg', nSettings, nState, skipped.length), { modal: true }, t().importConfirm);
    if (confirmed !== t().importConfirm) return;

    for (const short of Object.keys(apply)) {
      await config().update(short, apply[short], vscode.ConfigurationTarget.Global);
    }
    for (const key of Object.keys(stateApply)) await context.globalState.update(key, stateApply[key]);
    if (typeof apply.refreshInterval === 'number') startAutoRefresh();
    if (Object.prototype.hasOwnProperty.call(stateApply, PRESET_STATE_KEY)) currentPreset = stateApply[PRESET_STATE_KEY];
    if (currentPanel) rebuildShell();
    refresh(undefined, 'import');
    vscode.window.showInformationMessage(tf('importApplied', nSettings, nState));
    if (skipped.length) vscode.window.showWarningMessage(tf('importSkipped', skipped.length, skipped.slice(0, 6).join(', ')));
  }

  // ---- Commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek-usage-monitor.showUsage', () => openUsagePanel()),
    // 内部命令：只给状态栏点击用，不在 package.json 里声明（因此不出现在命令面板）
    vscode.commands.registerCommand('deepseek-usage-monitor.statusBarClick', () => onStatusBarClick()),
    vscode.commands.registerCommand('deepseek-usage-monitor.refresh', () => refresh(undefined, 'command')),
    vscode.commands.registerCommand('deepseek-usage-monitor.setApiKey', () => promptApiKeyFlow()),
    vscode.commands.registerCommand('deepseek-usage-monitor.setDashboardBackground', () => setDashboardBackground()),
    vscode.commands.registerCommand('deepseek-usage-monitor.clearDashboardBackground', () => clearDashboardBackground()),
    vscode.commands.registerCommand('deepseek-usage-monitor.exportConfig', () => exportConfig()),
    vscode.commands.registerCommand('deepseek-usage-monitor.importConfig', () => importConfig()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('deepseek-usage-monitor')) return;
      if (e.affectsConfiguration('deepseek-usage-monitor.refreshInterval')) startAutoRefresh();
      if (e.affectsConfiguration('deepseek-usage-monitor.language') && currentPanel) rebuildShell();
      if (e.affectsConfiguration('deepseek-usage-monitor.dashboard') && currentPanel) rebuildShell();
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
  sanitizeBgValue, bgSafeName, bgImagePath, resolveBackground, buildPanelHtml,
  sanitizeChartColor, hexToHsl, hslToHex, colorLadder, resolveChartConfig, chartColorMap, OFFICIAL_COST_COLORS,
  sanitizeConfigSetting, sanitizeConfigState, CONFIG_SETTING_KEYS, CONFIG_STATE_KEYS,
} };
