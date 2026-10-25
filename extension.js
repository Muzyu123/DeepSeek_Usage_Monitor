/*
 * DeepSeek Usage Monitor & Dashboard for VS Code
 * 基于 linnin233 的 MIT 项目：https://github.com/linnin233/deepseek-usage-vscode 进行了前端重构、后端修补和部分功能自定义
 *
 * 数据源：
 *   余额  → api.deepseek.com/user/balance (API Key sk-...)
 *   用量  → platform.deepseek.com/api/v0/usage/* (Session Token + Cookie)
 *
 * 面板视觉元素复刻自 DeepSeek 官方 platform.deepseek.com/usage（用量信息页）：
 *   包含充值余额 / 消费统计 / 时间范围（今天·昨天·近7天·近30天·本月·上月）/
 *   消费金额·API请求次数·Tokens 三张按模型堆叠柱状图
 */

const vscode = require('vscode');
const os = require('os');

// 从扩展脚本加载到 activate() 的耗时：配合 activationEvents 观察启动延迟
const LOADED_AT = Date.now();
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
const REFRESH_MAX_MINUTES = 1440; // 自动刷新间隔上限（一天）；超过 setInterval 的 32 位上限会退化为 1ms

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

const TZ_CLIENT_KEY = 'deepseekUsage.clientTimeZone';   // 面板上报的客户端时区（auto 模式用）
const COST_CARD_KEY = 'deepseekUsage.costCard';          // 首行消费统计卡：today / month / total

const L10N = {
  en: {
    title: 'DeepSeek Usage',
    usageTitle: 'Usage',
    tzNote: 'Current time zone: {0}. Data may be delayed up to 5 minutes.',
    tzInvalid: 'Unknown time zone: {0}. Falling back to the local time zone.',
    toppedUpBalance: 'Topped-up balance',
    grantedBalance: 'Granted balance',
    costCardTotal: 'Total cost',
    costCardSwitchHint: 'Switch the card content: today / this month / total',
    todayCost: "Today's cost",
    monthCostCard: "This month's cost",
    costAmount: 'Cost',
    currencyTag: ' ({0})',
    apiRequests: 'API requests',
    tokens: 'Tokens',
    tokenCacheHit: 'Input (cache hit)',
    tokenCacheMiss: 'Input (cache miss)',
    tokenOutput: 'Output',
    tokenCacheRate: 'Cache hit rate',
    rangeLabel: 'Time range',
    rangeToday: 'Today',
    rangeYesterday: 'Yesterday',
    rangeLast7: 'Last 7 days',
    rangeLast30: 'Last 30 days',
    rangeThisMonth: 'This month',
    rangeLastMonth: 'Last month',
    noDataRange: 'No data in this period',
    updatedAtLabel: 'Updated {0}',
    loading: 'Loading...', refresh: 'Refresh',
    settings: '⚙ Settings', setApiKey: 'Set API Key', setBg: 'Set Background',
    menuTitle: 'Settings', menuOpenSettings: 'Open Settings',
    menuConfigTransfer: 'Migrate configuration',
    menuImport: 'Import configuration', menuExport: 'Export configuration',
    sbTodayCost: 'Today', sbMonthCost: 'Month', sbBalance: 'Balance', sbTodayTokens: 'Today',
    noSessionToken: 'Configure Session Token & Cookie',
    errNoApiKey: 'Set API Key',
    loadFailed: 'Failed to load usage data. Try refreshing or updating the Session Token / Cookie',
    sessionExpired: 'Session expired — update the Session Token',
    balanceInsufficient: 'Insufficient balance',
    keySessionOnly: 'Session only (system keyring unavailable)',
    enterApiKey: 'Enter DeepSeek API Key',
    errEmptyKey: 'Input is empty: enter an API Key (format sk-xxx)',
    errKeyFormat: 'Invalid format: the API Key must start with sk- (format sk-xxx)',
    keySaved: 'API Key saved',
    keySavedSession: 'API Key saved (valid only for this time)',
    keyPersistFailed: 'API Key is active for this session only: the system keyring is unavailable, re-enter it after restart',
    keyringUnavailable: 'System keyring unavailable ({0}): re-enter the API Key; it will only be valid for this session and must be re-entered after a restart',
    keyReadTimeout: 'read timed out after {0}ms',
    keyReadFailed: 'read failed',
    keyNotPersisted: 'the API Key saved earlier could not be read',
    errApiKey401: 'API Key invalid (401)',
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
    bgPickTitle: 'Select a background image',
    bgPathPrompt: 'Enter the local absolute path of the image',
    bgFileMissing: 'File not found: {0}',
    bgBadFormat: 'Unsupported image format: {0}',
    bgTooLarge: 'Image is too large ({0} MB); the limit is {1} MB',
    bgSet: 'Dashboard background image set',
    bgCleared: 'Dashboard background image cleared',
    bgPickActionTitle: 'Select an action',
    chartColorsBtn: 'Colors',
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
    tzNote: '当前时区：{0}，数据可能有 5 分钟延迟。',
    tzInvalid: '无法识别的时区：{0}，已回落为跟随本机时区。',
    toppedUpBalance: '充值余额',
    grantedBalance: '赠送金额',
    costCardTotal: '累计消费',
    costCardSwitchHint: '切换卡片显示内容：今日消费 / 本月消费 / 累计消费',
    todayCost: '今日消费',
    monthCostCard: '本月消费',
    costAmount: '消费金额',
    currencyTag: '（{0}）',
    apiRequests: 'API 请求次数',
    tokens: 'Tokens',
    tokenCacheHit: '输入（命中缓存）',
    tokenCacheMiss: '输入（未命中缓存）',
    tokenOutput: '输出',
    tokenCacheRate: '缓存命中率',
    rangeLabel: '时间范围',
    rangeToday: '今天',
    rangeYesterday: '昨天',
    rangeLast7: '近7天',
    rangeLast30: '近30天',
    rangeThisMonth: '本月',
    rangeLastMonth: '上月',
    noDataRange: '该时间段暂无数据',
    updatedAtLabel: '数据更新时间 {0}',
    loading: '加载中...', refresh: '刷新',
    settings: '⚙ 设置', setApiKey: '设置 API Key', setBg: '设置背景图',
    menuTitle: '设置', menuOpenSettings: '打开设置',
    menuConfigTransfer: '迁移配置',
    menuImport: '读取配置', menuExport: '导出配置',
    sbTodayCost: '本日消费', sbMonthCost: '本月消费', sbBalance: '账户余额', sbTodayTokens: '本日消耗',
    noSessionToken: '请在设置中配置 Session Token 和 Cookie',
    errNoApiKey: '请设置 API Key',
    loadFailed: '加载用量数据失败，请尝试刷新或更新Session Token/Cookie',
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
    errApiKey401: 'API Key 无效(401)',
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
    bgPickTitle: '选择背景图片',
    bgPathPrompt: '请输入图片的本地绝对路径',
    bgFileMissing: '文件不存在：{0}',
    bgBadFormat: '不支持的图片格式：{0}',
    bgTooLarge: '图片过大（{0} MB），上限 {1} MB',
    bgSet: '面板背景图已设置',
    bgCleared: '面板背景图已清除',
    bgPickActionTitle: '请选择操作',
    chartColorsBtn: '配色',
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

// 自动刷新间隔（毫秒）：非正数或非法值 = 关闭；上限 1440 分钟，避免超过 setInterval 的 32 位上限
function refreshIntervalMs(raw) {
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.min(minutes, REFRESH_MAX_MINUTES) * 60 * 1000;
}

// ============================================================
//  Time Zone —— 默认 UTC+8；可跟随客户端，或由设置指定任意 IANA 时区
// ============================================================
const DEFAULT_ZONE = 'Etc/GMT-8';   // IANA 的 Etc 区符号与直觉相反：Etc/GMT-8 就是 UTC+8
let activeZone = DEFAULT_ZONE;
const zoneFmtCache = new Map();

// 固定偏移时区（Etc/GMT±N、UTC）可以纯算术换算，不初始化 Intl。
// 默认时区就走这条路：启动路径不付 ICU 初始化的钱（首次创建 Intl 格式器可达数百毫秒）
function fixedOffsetOf(zone) {
  const z = zone || activeZone;
  const m = /^Etc\/GMT([+-])(\d{1,2})$/.exec(z);
  if (m) return (m[1] === '-' ? 1 : -1) * Number(m[2]) * 3600;
  if (z === 'UTC' || z === 'Etc/UTC') return 0;
  return null;
}

function zoneValid(zone) {
  if (!zone || typeof zone !== 'string') return false;
  if (fixedOffsetOf(zone) != null) return true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch (e) { return false; }
}

// 友好别名：GMT+8 / UTC-5 → Etc/GMT-8 / Etc/GMT+5（Etc 区只支持整小时）
function normalizeZone(raw) {
  const str = String(raw == null ? '' : raw).trim();
  if (!str) return '';
  const m = /^(?:GMT|UTC)\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(str);
  if (m) {
    if (m[3] && m[3] !== '00') return '';
    return 'Etc/GMT' + (m[1] === '+' ? '-' : '+') + String(Number(m[2]));
  }
  return zoneValid(str) ? str : '';
}

function setActiveZone(zone) {
  if (zoneValid(zone)) activeZone = zone;
  return activeZone;
}

function zoneFmt(zone) {
  const z = zone || activeZone;
  let f = zoneFmtCache.get(z);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: z, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    zoneFmtCache.set(z, f);
  }
  return f;
}

// 绝对秒 → 该时区的日历字段（hour 24 归 0）
function zoneParts(tsSec, zone) {
  const fixed = fixedOffsetOf(zone);
  if (fixed != null) {
    const d = new Date((tsSec + fixed) * 1000);
    return {
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
      hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
    };
  }
  const p = {};
  for (const it of zoneFmt(zone).formatToParts(new Date(tsSec * 1000))) p[it.type] = it.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second),
  };
}

// 该时区在某一刻的偏移（秒，东正西负）
function zoneOffsetSec(tsSec, zone) {
  const fixed = fixedOffsetOf(zone);
  if (fixed != null) return fixed;
  const p = zoneParts(tsSec, zone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - tsSec * 1000) / 1000);
}

// 该时区日历日 00:00 的绝对秒。跨 DST 时以当天 00:00 的偏移为准，二次校正
function zoneDayStartSecOf(year, month, day, zone) {
  const naive = Math.floor(Date.UTC(year, month - 1, day) / 1000);
  const off = zoneOffsetSec(naive, zone);
  let start = naive - off;
  const off2 = zoneOffsetSec(start, zone);
  if (off2 !== off) start = naive - off2;
  return start;
}

function zoneDayStartSec(tsSec, zone) {
  const p = zoneParts(tsSec, zone);
  return zoneDayStartSecOf(p.year, p.month, p.day, zone);
}

// 绝对秒 → 所属时区整点（+05:30 这类偏移也对齐到本地整点）
function zoneHourStartSec(tsSec, zone) {
  const off = zoneOffsetSec(tsSec, zone);
  const startLocal = Math.floor((tsSec + off) / 3600) * 3600;
  const start = startLocal - off;
  const off2 = zoneOffsetSec(start, zone);
  return off2 === off ? start : startLocal - off2;
}

// 文案用的偏移标签：该时刻的 GMT±H（含半小时区，如 GMT+5:30）。
// 用偏移而不是 IANA 名：文案要显示「现在时区：GMT+N」，跨 DST 时也以当前偏移为准
function zoneGmtLabel(tsSec, zone) {
  const off = zoneOffsetSec(tsSec, zone);
  const abs = Math.abs(off);
  const h = Math.floor(abs / 3600), mi = Math.floor((abs % 3600) / 60);
  return `GMT${off >= 0 ? '+' : '-'}${h}${mi ? ':' + pad2(mi) : ''}`;
}

// 某一刻的偏移标签：UTC+08:00
function zoneOffsetLabel(tsSec, zone) {
  const off = zoneOffsetSec(tsSec, zone);
  const abs = Math.abs(off);
  return `UTC${off >= 0 ? '+' : '-'}${pad2(Math.floor(abs / 3600))}:${pad2(Math.floor((abs % 3600) / 60))}`;
}

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
    headers: { Authorization: `Bearer ${sessionToken}`, Cookie: cookie || '', 'x-client-locale': 'zh_CN', 'x-client-platform': 'web', 'x-client-timezone-offset': String(zoneOffsetSec(Math.floor(Date.now() / 1000))), 'x-client-version': '1.0.0', Referer: 'https://platform.deepseek.com/usage', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36' },
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

// 区间接口显式传 tz=<偏移秒>，平台按该偏移分桶并返回原始小时桶，本地再按逐时刻时区聚合。
// 旧的月接口按 UTC 分桶（00:00–08:00 UTC+8 的消费会落到前一天），1.1.5 起已移除，不得回退。

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
    const p = zoneParts(sec);
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  };
  if (spec.granularity === 'hour') {
    const a = zoneParts(spec.startSec);
    // 终点落在本地 00:00 时写 24:00，避免显示成与起点相同的 00:00
    const endHour = zoneDayStartSec(spec.endSec) === spec.endSec ? 24 : zoneParts(spec.endSec).hour;
    return `${ymd(spec.startSec)} ${pad2(a.hour)}:00 ~ ${pad2(endHour)}:00`;
  }
  const last = barMeta(spec, spec.slots - 1);
  return `${ymd(spec.startSec)} ~ ${last.key}`;
}

function isPreset(id) { return RANGE_PRESET_DEFS.some((d) => d.id === id); }
function presetDef(id) {
  return RANGE_PRESET_DEFS.find((d) => d.id === id) || RANGE_PRESET_DEFS.find((d) => d.id === DEFAULT_PRESET);
}

// 窗口区间为左闭右开 [startSec, endSec)。今天/近7天/近30天/本月的 end 落在未来
// （官方用量页同样如此且平台接受）；渲染多少槽由 visibleSlotCount 决定，不裁剪请求。
// 日粒度端点按日历日计算，不使用 ±86400 秒：DST 切换日的本地一天是 23/25 小时。
// nowMs 可注入，便于对跨月、月初、月末等时刻做确定性测试。
function resolveRange(id, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const t = zoneParts(Math.floor(now / 1000));
  const y = t.year, mo = t.month, d = t.day;
  const todayStart = zoneDayStartSecOf(y, mo, d);
  const tomorrowStart = zoneDayStartSecOf(y, mo, d + 1);
  const monthStart = zoneDayStartSecOf(y, mo, 1);
  const def = presetDef(id);
  const mk = (startSec, endSec, granularity) => {
    const slotSec = SLOT_SEC[granularity];
    return { id: def.id, startSec, endSec, granularity, slotSec, slots: Math.round((endSec - startSec) / slotSec) };
  };
  if (def.id === 'today') return mk(todayStart, tomorrowStart, 'hour');
  if (def.id === 'yesterday') return mk(zoneDayStartSecOf(y, mo, d - 1), todayStart, 'hour');
  if (def.id === 'last7') return mk(zoneDayStartSecOf(y, mo, d - 6), tomorrowStart, 'day');
  if (def.id === 'last30') return mk(zoneDayStartSecOf(y, mo, d - 29), tomorrowStart, 'day');
  if (def.id === 'lastMonth') {
    const prev = new Date(Date.UTC(y, mo - 2, 1));   // mo-2：JS 月份从 0 起算，减 2 即上一月
    return mk(zoneDayStartSecOf(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 1), monthStart, 'day');
  }
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return mk(monthStart, zoneDayStartSecOf(y, mo, daysInMonth + 1), 'day');
}

// 绝对秒 → 所属槽的绝对秒，按当前时区对齐：
// 小时槽取该时区的整点（+05:30 这类偏移也对齐本地整点）；
// 日槽取该时区的日界（按 UTC 分桶会产生固定 8 小时偏差，已在 1.1.5 修复过）。
function slotStartSec(tsSec, granularity) {
  if (granularity === 'hour') return zoneHourStartSec(tsSec);
  return zoneDayStartSec(tsSec);
}

// 可见槽数 = 已过去的槽 + 当前槽（"只画到今天/当前小时"，六种预设通用）。
// 日粒度按日历日差计算：DST 切换日的本地一天不是 86400 秒，秒差除法会少算/多算一根。
function visibleSlotCount(spec, nowMs) {
  const nowSec = Math.floor((nowMs == null ? Date.now() : nowMs) / 1000);
  if (nowSec < spec.startSec) return 0;
  if (nowSec >= spec.endSec) return spec.slots;
  let elapsed;
  if (spec.granularity === 'hour') {
    elapsed = Math.floor((nowSec - spec.startSec) / spec.slotSec) + 1;
  } else {
    const a = zoneParts(spec.startSec), b = zoneParts(nowSec);
    const days = Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000);
    elapsed = days + 1;
  }
  return Math.max(0, Math.min(spec.slots, elapsed));
}

// 窗口是否恰好从本月 1 日 00:00 开始：此时窗口合计即"本月至今"合计，可复用而不另取数。
// 起点早于本月 1 日（近 7 / 30 天跨越上月末）时窗口合计包含上月金额，不能复用。
function coversMonthToDate(spec, nowMs) {
  if (spec.granularity !== 'day') return false;
  const now = nowMs == null ? Date.now() : nowMs;
  const t = zoneParts(Math.floor(now / 1000));
  const monthStart = zoneDayStartSecOf(t.year, t.month, 1);
  return spec.startSec === monthStart && spec.endSec > Math.floor(now / 1000);
}

async function fetchUsageRange(sessionToken, cookie, proxy, startSec, endSec) {
  // tz = 窗口起点对应的偏移秒（东正西负）：跨 DST 的窗口平台按起点偏移分桶，
  // 但返回的是绝对时间的小时桶，本地仍按逐时刻的时区换算聚合
  const q = `?start=${startSec}&end=${endSec}&tz=${zoneOffsetSec(startSec)}`;
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
  // 纯数字字符串按 Unix 秒/毫秒处理；否则会被 Date.parse 当成年份而丢弃
  if (/^\d+$/.test(str)) {
    const n = Number(str);
    return Number.isFinite(n) ? Math.floor(n > 1e12 ? n / 1000 : n) : null;
  }
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
// 余额：balance_infos 每项一个币种，全部读进来（不做汇率换算，多币种逐项展示）
function parseBalanceItems(balance) {
  const infos = (balance && Array.isArray(balance.balance_infos)) ? balance.balance_infos : [];
  const items = [];
  for (const info of infos) {
    if (!info) continue;
    const currency = String(info.currency || '').toUpperCase();
    const num = (v) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);
    if (!currency && !num(info.total_balance)) continue;
    items.push({ currency, total: num(info.total_balance), toppedUp: num(info.topped_up_balance), granted: num(info.granted_balance) });
  }
  return items;
}

// 账号概览（/api/v0/users/get_user_summary）→ 累计消费按币种返回（金额是字符串）
// 业务层失败时 biz_data 为 null（顶层 code 仍可能是 0），不能当作"累计为 0"
function hasSummaryData(json) {
  return !!(json && json.data && json.data.biz_data);
}
function parseTotalCosts(json) {
  const biz = json && json.data && json.data.biz_data;
  const list = (biz && Array.isArray(biz.total_costs)) ? biz.total_costs : [];
  const out = [];
  for (const it of list) {
    if (!it) continue;
    const currency = String(it.currency || '').toUpperCase();
    const amount = parseFloat(it.amount);
    if (!Number.isFinite(amount)) continue;
    out.push({ currency, amount });
  }
  out.sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
  return out;
}

// 区间响应 → 按币种分组：[{currency, series}]。amount 侧不带币种（''），cost 侧每组一个币种
function seriesGroups(apiJson) {
  const biz = apiJson && apiJson.data && apiJson.data.biz_data;
  if (!biz) return [];
  const groups = [];
  for (const g of (Array.isArray(biz) ? biz : [biz])) {
    if (!g) continue;
    if (Array.isArray(g.series)) groups.push({ currency: '', series: g.series });
    const inner = Array.isArray(g.data) ? g.data : (g.data ? [g.data] : []);
    for (const sub of inner) {
      if (sub && Array.isArray(sub.series)) groups.push({ currency: String(sub.currency || '').toUpperCase(), series: sub.series });
    }
  }
  return groups;
}

// 不分币种汇总 series（请求次数 / Tokens 与币种无关，用得到）
function seriesOf(apiJson) {
  return seriesGroups(apiJson).reduce((acc, g) => acc.concat(g.series), []);
}

// 展示用币种：优先账户主币种（余额第一项），不在用量里就取用量里的第一个
function pickDisplayCurrency(balItems, agg) {
  const list = (agg && Array.isArray(agg.currencies)) ? agg.currencies : [];
  const primary = (Array.isArray(balItems) && balItems[0] && balItems[0].currency) || '';
  if (primary && list.indexOf(primary) >= 0) return primary;
  return list[0] || '';
}

// 槽 → 展示元数据（date/label/tipHead 是唯一出现日期字符串的地方）
function barMeta(spec, idx) {
  // 日粒度按日历日推进：跨 DST 时 start + idx*86400 可能落在前一天的 23:00 或当天的 01:00
  let slotSec;
  if (spec.granularity === 'hour') {
    slotSec = spec.startSec + idx * spec.slotSec;
  } else {
    const s = zoneParts(spec.startSec);
    slotSec = zoneDayStartSecOf(s.year, s.month, s.day + idx);
  }
  const d = zoneParts(slotSec);
  const date = `${pad2(d.month)}-${pad2(d.day)}`;
  const ymd = `${d.year}-${date}`;
  if (spec.granularity === 'hour') {
    const hh = d.hour;
    const from = `${pad2(hh)}:00`;
    const to = hh === 23 ? '24:00' : `${pad2(hh + 1)}:00`;   // 末槽写 24:00，避免被读成次日 00:00
    return { kind: 'hour', key: `${ymd}T${pad2(hh)}`, date, hour: hh, from, to,
      label: [from], tipHead: `${date} ${from}–${to}` };   // 轴刻度只写起点（与官方一致），区间留给浮层
  }
  return { kind: 'day', key: ymd, date, day: d.day,
    label: [`${d.month}/${d.day}`], tipHead: ymd };
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
    if (!c) { c = { cacheHit: 0, cacheMiss: 0, output: 0, requests: 0, costBy: {} }; byModel.set(model, c); }
    return c;
  };
  const absorb = (json, isCost) => {
    // cost 侧按币种分组：金额记到各自币种名下，绝不跨币种相加（请求次数 / Tokens 与币种无关）
    for (const group of seriesGroups(json)) {
    for (const series of group.series) {
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
          const cell = cellAt(ci, model);
          cell.costBy[group.currency] = (cell.costBy[group.currency] || 0) + c;
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
      if (!m) { m = { model, cacheHit: 0, cacheMiss: 0, output: 0, requests: 0, costBy: {} }; modelMap.set(model, m); }
      m.cacheHit += c.cacheHit; m.cacheMiss += c.cacheMiss; m.output += c.output;
      m.requests += c.requests;
      for (const cur of Object.keys(c.costBy)) m.costBy[cur] = (m.costBy[cur] || 0) + c.costBy[cur];
    }
  }
  const models = [...modelMap.values()].filter((m) => m.cacheHit + m.cacheMiss + m.output + m.requests > 0);
  const modelOrder = models.map((m) => m.model);
  const bars = [];
  for (let i = 0; i < visible; i++) {
    const byModel = slotMap.get(i) || new Map();
    // parts 按 models 顺序排列：颜色与浮层行序都依赖它，不能按金额排序
    // parts 同时带三种口径（消费 / 请求 / Tokens）：三条柱状图各取自己那一列。
    // 只要任一口径 > 0 就保留，否则「有请求没消费」的模型会在请求图里凭空消失；
    // 消费图里它的高度是 0，本来就看不见，浮层也按各口径自行过滤
    const parts = modelOrder.filter((m) => {
      const c = byModel.get(m);
      return c && (Object.keys(c.costBy).length || c.requests > 0 || c.cacheHit + c.cacheMiss + c.output > 0);
    }).map((m) => {
      const c = byModel.get(m);
      const costBy = {};
      for (const cur of Object.keys(c.costBy)) if (c.costBy[cur] > 0) costBy[cur] = c.costBy[cur];
      // tokens 的三个分项随 parts 一起下发：Tokens 图的浮层要显示命中 / 未命中 / 输出与命中率
      return { model: m, costBy, requests: c.requests, tokens: c.cacheHit + c.cacheMiss + c.output,
        cacheHit: c.cacheHit, cacheMiss: c.cacheMiss, output: c.output };
    });
    let tokens = 0, requests = 0, cacheHit = 0, cacheMiss = 0, output = 0;
    for (const c of byModel.values()) {
      tokens += c.cacheHit + c.cacheMiss + c.output; requests += c.requests;
      cacheHit += c.cacheHit; cacheMiss += c.cacheMiss; output += c.output;
    }
    // 每根柱子带各币种合计（消费图按所选币种取这一列）
    const barCostBy = {};
    for (const p of parts) for (const cur of Object.keys(p.costBy)) barCostBy[cur] = (barCostBy[cur] || 0) + p.costBy[cur];
    bars.push(Object.assign(barMeta(spec, i), { costBy: barCostBy, tokens, requests, cacheHit, cacheMiss, output, parts }));
  }
  // 币种列表与各币种合计：多币种时面板据此出「币种切换」，且各币种金额互不相加
  const totalCostBy = {};
  for (const m of models) for (const cur of Object.keys(m.costBy)) totalCostBy[cur] = (totalCostBy[cur] || 0) + m.costBy[cur];
  const currencies = Object.keys(totalCostBy).filter((c) => totalCostBy[c] > 0).sort();
  return {
    spec, currencies, totalCostBy, granularity: spec.granularity, slots: spec.slots, visible, models, bars,
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

// 文件对话框的默认目录：给 file: 方案的 defaultUri 时 VSCode 才会弹客户端原生对话框；
// 不给的话远程窗口会按窗口默认（远端工作区）打开远端目录
function localDialogDir() {
  const pics = path.join(os.homedir(), 'Pictures');
  try { if (fs.statSync(pics).isDirectory()) return pics; } catch (e) { /* 没有就退回主目录 */ }
  return os.homedir();
}

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
// 三张柱状图（消费金额 / API 请求次数 / Tokens）各自一套配色，互不影响；
// 官方色阶按图区分，同一模型在不同图里的颜色因此可能不同
const CHART_METRICS = ['cost', 'requests', 'tokens'];
const CHART_COLORS_KEY = 'deepseekUsage.chartColors';   // { cost|requests|tokens: {mode, modelColors, baseColor} }
// 2.2.0 及以前只有一套配色，语义上就是「消费金额」图：只读兼容，不再写入
const CHART_LEGACY_KEYS = {
  mode: 'deepseekUsage.chartColorMode',
  modelColors: 'deepseekUsage.chartModelColors',
  baseColor: 'deepseekUsage.chartBaseColor',
};
const CHART_COLOR_DEFAULT = '#FFAA00';   // 官方色阶首色，同时作为单主色模式的默认主色
// 官方色阶（从官网用量页图表的 SVG 里直接采样柱子填充色，按叠放顺序自下而上）：
// 三张图的主题色本就不同 —— 消费金额是橙→黄梯度，Tokens 是蓝色梯度；
// API 请求次数官网是单序列单色（#70B2FE），这里同色系补两档以支持按模型叠加
const OFFICIAL_COLORS = {
  cost: ['#FF5500', '#FF8800', '#FFAA00', '#FED400', '#FEF24C'],
  requests: ['#70B2FE', '#0C70F3', '#A0DCFD'],
  tokens: ['#0C70F3', '#60B3FE', '#A0DCFD'],
};

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

// 单张图的配色配置：模式只认白名单，颜色只认 hex，越界一律回落
function sanitizeChartConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const modeRaw = String(src.mode || '');
  const modelColors = {};
  const rawMap = src.modelColors;
  if (rawMap && typeof rawMap === 'object') {
    for (const key of Object.keys(rawMap)) {
      const c = sanitizeChartColor(rawMap[key]);
      if (c) modelColors[String(key)] = c;
    }
  }
  return {
    mode: CHART_COLOR_MODES.indexOf(modeRaw) >= 0 ? modeRaw : 'official',
    modelColors,
    baseColor: sanitizeChartColor(src.baseColor) || CHART_COLOR_DEFAULT,
  };
}

// 三张图的配置来自设置项 chartColors（随 Settings Sync / 配置导出迁移）。
// 老版本存在 globalState 里（三图对象或更早的单一配置）：没有该设置项时由 legacySrc 回退提供，
// 激活时会一次性迁移进设置项并清掉老状态，避免两处真源
function resolveChartConfigs(rawCfg, legacySrc) {
  const raw = (rawCfg && typeof rawCfg === 'object' && !Array.isArray(rawCfg)) ? rawCfg : null;
  const legacy = sanitizeChartConfig(legacySrc || null);
  const out = {};
  CHART_METRICS.forEach((metric) => {
    if (raw && raw[metric]) { out[metric] = sanitizeChartConfig(raw[metric]); return; }
    out[metric] = (!raw && metric === 'cost') ? legacy : sanitizeChartConfig(null);
  });
  return out;
}

// 三张图各自的「模型名 → 颜色」表：面板只查表，不在前端重算
function chartColorsAll(cfgs, models) {
  const out = {};
  CHART_METRICS.forEach((metric) => { out[metric] = chartColorMap(cfgs[metric], models, metric); });
  return out;
}

function officialPalette(metric) {
  return OFFICIAL_COLORS[CHART_METRICS.indexOf(metric) >= 0 ? metric : 'cost'];
}

// 模型名 → 颜色。单一主色或按模型指定时未覆盖的模型回落到该图自己的官方色阶
function chartColorMap(cfg, models, metric) {
  const palette = officialPalette(metric);
  const list = Array.isArray(models) ? models : [];
  const ladder = cfg.mode === 'mono' ? colorLadder(cfg.baseColor, list.length) : [];
  const map = {};
  list.forEach((name, i) => {
    if (cfg.mode === 'model' && cfg.modelColors[name]) map[name] = cfg.modelColors[name];
    else if (cfg.mode === 'mono' && ladder[i]) map[name] = ladder[i];
    else map[name] = palette[i % palette.length];
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
  'charts.items', 'timezone', 'chartColors',
  'dashboard.backgroundColor', 'dashboard.backgroundDim', 'dashboard.cardOpacity', 'dashboard.fontScale',
];
// 导出只写新键；老键留在白名单里，是为了还能读入 2.2.0 之前导出的配置文件
const CONFIG_STATE_KEYS = [PRESET_STATE_KEY, CHART_COLORS_KEY,
  CHART_LEGACY_KEYS.mode, CHART_LEGACY_KEYS.modelColors, CHART_LEGACY_KEYS.baseColor];
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
    case 'charts.items': {
      if (!Array.isArray(value)) return undefined;
      return Array.from(new Set(value.filter((v) => CHART_METRICS.indexOf(v) >= 0)));
    }
    case 'timezone': {
      const raw = String(value == null ? '' : value).trim();
      if (!raw) return '';                                    // 空 = 跟随客户端
      return normalizeZone(raw) || undefined;                 // 认不出来就不导入
    }
    case 'chartColors': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const out = {};
      CHART_METRICS.forEach((metric) => { if (value[metric]) out[metric] = sanitizeChartConfig(value[metric]); });
      return out;   // 空对象合法：表示三张图都恢复官方色阶（导出默认配置后可导入重置）
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
    case 'dashboard.cardOpacity': {
      const n = Number(value);
      return Number.isFinite(n) && n >= BG_CARD_OPACITY_MIN && n <= 1 ? Math.round(n * 100) / 100 : undefined;
    }
    case 'dashboard.fontScale': {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0.8 && n <= 1.4 ? Math.round(n * 100) / 100 : undefined;
    }
    default:
      return undefined;
  }
}

function sanitizeConfigState(key, value) {
  if (key === PRESET_STATE_KEY) return isPreset(String(value || '')) ? String(value) : undefined;
  if (key === CHART_COLORS_KEY) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    CHART_METRICS.forEach((metric) => { if (value[metric]) out[metric] = sanitizeChartConfig(value[metric]); });
    return Object.keys(out).length ? out : undefined;
  }
  if (key === CHART_LEGACY_KEYS.mode) return CHART_COLOR_MODES.indexOf(String(value)) >= 0 ? String(value) : undefined;
  if (key === CHART_LEGACY_KEYS.baseColor) return sanitizeChartColor(value) || undefined;
  if (key === CHART_LEGACY_KEYS.modelColors) {
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
// 数据不写入 HTML：只有面板创建与语言变化时重建外壳，其余一律通过 postMessage 推送数据


// 三张柱状图的静态描述：外壳按「charts.items」的顺序与取舍生成对应卡片
// （height 只影响外部尺寸，三张图同高；id 与面板脚本的 CHART_DEFS 一一对应）
// 三张图的官方色阶各不相同（消费金额为橙→黄梯度，Tokens 为蓝色梯度，请求次数为单色系），
// 因此同一模型在不同图里的颜色不保证一致
const CHART_SPECS = {
  cost: { titleKey: 'costAmount', total: 'chartTotal', legend: 'costLegend', canvas: 'costChart', wrap: 'costWrap', btn: 'colorBtnCost', height: 220, currency: true },
  requests: { titleKey: 'apiRequests', total: 'reqTotal', legend: 'reqLegend', canvas: 'reqChart', wrap: 'reqWrap', btn: 'colorBtnReq', height: 220 },
  tokens: { titleKey: 'tokens', total: 'tokTotal', legend: 'tokLegend', canvas: 'tokChart', wrap: 'tokWrap', btn: 'colorBtnTok', height: 220 },
};

function buildPanelHtml(i18n, langCode, selectedPreset, bg, charts, fontScale) {
  const rangeOpts = RANGE_PRESET_DEFS
    .map((d) => `<option value="${d.id}"${d.id === selectedPreset ? ' selected' : ''}>${i18n[d.key]}</option>`).join('');
  const rangeIds = JSON.stringify(RANGE_PRESET_DEFS.map((d) => d.id));
  // 图表卡片：顺序 = 配置顺序；未配置的图不生成（面板脚本对缺失的 canvas / 按钮都有判空）
  const chartCards = (Array.isArray(charts) ? charts : CHART_METRICS).map((metric) => {
    const sp = CHART_SPECS[metric];
    if (!sp) return '';
    // 只有消费金额图带「（币种）」与币种下拉
    const currencyCtl = sp.currency
      ? '<span class="cur" id="costCur"></span><select class="cur-select" id="curSelect" hidden></select>'
      : '';
    return `<div class="card chart-card" style="margin-top:12px">
  <div class="card-head">
    <div class="chart-title">${i18n[sp.titleKey]}${currencyCtl}<span class="chart-total" id="${sp.total}"></span></div>
    <div class="legend" id="${sp.legend}"></div>
    <button class="btn btn-light color-btn" id="${sp.btn}">${i18n.chartColorsBtn}</button>
  </div>
  <div class="chart-wrap" id="${sp.wrap}"><canvas id="${sp.canvas}" style="width:100%;height:${sp.height}px"></canvas></div>
</div>`;
  }).join('\n');
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

  const html = `<!DOCTYPE html><html lang="${htmlLang}">
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
/* 赠送金额 > 0 时首行多一张卡，列数随之变成 3（卡本身由脚本显隐） */
.cards-2.gift{grid-template-columns:repeat(3,minmax(0,1fr))}
.cards-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.card{background:var(--ds-card-bg,var(--vscode-editorWidget-background,var(--vscode-input-background)));border:1px solid var(--vscode-widget-border,rgba(128,128,128,.25));border-radius:6px;padding:14px 16px;min-width:0}
.card-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.card .label{font-size:11px;color:var(--vscode-editor-foreground);margin-bottom:6px}
.card .value{display:inline-block;font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.card .suffix{font-size:11px;color:var(--vscode-descriptionForeground);margin-left:6px}
/* 多币种账户：每个币种一组「数值 + 代码小字」，组间用 + 连接（不做符号映射，也不做汇率换算）*/
.value-group{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 4px}
.plus{color:var(--vscode-descriptionForeground);font-size:13px;align-self:center;margin:0 2px}
.chart-title .cur{color:var(--vscode-descriptionForeground);font-size:12px;margin-left:3px}
/* 多币种时的切换下拉：贴着「消费金额（币种）合计」右侧 */
.chart-title .cur-select{margin-left:8px;padding:1px 4px;font-size:11px;border-radius:4px;cursor:pointer;color:var(--vscode-editor-foreground);background:var(--vscode-dropdown-background,var(--vscode-input-background));border:1px solid var(--vscode-widget-border,rgba(128,128,128,.35))}
.chart-title .cur-select[hidden]{display:none}
/* 首行消费统计卡的循环切换按钮（右上角）：今日 → 本月 → 累计 → 今日 */
.cost-stat-card{position:relative}
.cost-stat-cycle{position:absolute;top:10px;right:12px;padding:1px 6px;border:1px solid var(--vscode-widget-border,rgba(128,128,128,.35));border-radius:4px;background:var(--vscode-button-secondaryBackground,transparent);color:var(--vscode-descriptionForeground);font-size:12px;line-height:18px;cursor:pointer}
.cost-stat-cycle:hover{color:var(--vscode-editor-foreground);background:var(--vscode-button-secondaryHoverBackground,var(--vscode-list-hoverBackground))}
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
#chart-tip .tip-model{margin-top:4px;font-weight:600}
#chart-tip .tip-sub{padding-left:16px}
#chart-tip .tip-sub span:first-child{color:var(--vscode-descriptionForeground)}
#chart-tip .tip-dot{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:6px;vertical-align:middle}
.chart-card{position:relative}
.chart-card .card-head{padding-right:78px}   /* 给右上角的「配色」按钮让位，图例不会压到它 */
.chart-card .color-btn{position:absolute;top:12px;right:14px}
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
<div class="subtitle" id="tzNote"></div>
<div id="errBanner" class="banner" hidden></div>

<div class="cards-2" id="topRow">
  <div class="card">
    <div class="card-row">
      <div style="min-width:0">
        <div class="label">${i18n.toppedUpBalance}</div>
        <div class="value-group" id="topupValue"><span class="value">—</span></div>
      </div>
    </div>
    <div class="sub" id="topupSub"></div>
  </div>
  <div class="card cost-stat-card">
    <div class="label" id="costStatLabel">${i18n.todayCost}</div>
    <div class="value-group" id="todayValue"><span class="value">—</span></div>
    <div class="sub" id="todaySub"></div>
    <button class="cost-stat-cycle" id="costStatCycle" title="${i18n.costCardSwitchHint}">⇄</button>
  </div>
  <div class="card" id="giftCard" hidden>
    <div class="label">${i18n.grantedBalance}</div>
    <div class="value-group" id="giftValue"><span class="value">—</span></div>
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
    <div class="value-group" id="mCost"><span class="value">—</span></div>
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

${chartCards}

<div class="color-panel" id="colorPanel" hidden></div>

<script>
(function() {
const vsc = acquireVsCodeApi();
// 固定文案仅重建外壳时更新；运行期动态文案随数据一起推送更新
var I18N = ${JSON.stringify(i18n).replace(/</g, '\\u003c')};
var RANGE_IDS = ${rangeIds};
var FONT_SCALE = ${Number.isFinite(fontScale) ? fontScale : 1};
var D = null;                 // 最近一次由扩展推送的数据
var busySafety = null;        // 刷新按钮的超时解锁计时器（请求无响应时自动恢复）

// 官方「消费金额」柱状图色阶（截图像素采样），由宿主注入；用于 D.colors 未覆盖的模型
var OFFICIAL_COLORS = ${JSON.stringify(OFFICIAL_COLORS)};
var TZ_DEFAULT = ${JSON.stringify(activeZone)};   // 外壳构建时的时区；数据到达后以载荷里的 tzZone 为准
var TZ_LABEL = ${JSON.stringify(zoneGmtLabel(Math.floor(Date.now() / 1000), activeZone))};

function i18n() { return (D && D.i18n) || I18N || {}; }
function fmtCost(n) { return (parseFloat(n) || 0).toFixed(2); }
function fmtInt(n) { return Math.round(parseFloat(n) || 0).toLocaleString('en-US'); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function p2(n) { return (n < 10 ? '0' : '') + n; }
// 数据更新时间：面板所有时间统一按当前时区（与 tzNote 一致）。
// short=true 用于正文（同一时区日仅显示 HH:MM:SS，跨日带月-日），short=false 用于 title（完整 YYYY-MM-DD HH:MM:SS）
// 面板侧时区：优先用载荷带来的（宿主已按设置/客户端时区解析），否则用外壳构建时的值
function panelZone() { return (D && D.tzZone) || TZ_DEFAULT; }
var zoneFmts = {};
function zonePartsOf(ms) {
  var zone = panelZone();
  var f = zoneFmts[zone];
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    zoneFmts[zone] = f;
  }
  var p = {};
  f.formatToParts(new Date(ms)).forEach(function(it) { p[it.type] = it.value; });
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}
function fmtClock(ms, short) {
  var t = zonePartsOf(ms), now = zonePartsOf(Date.now());
  var ymd = t.year + '-' + t.month + '-' + t.day;
  var nowYmd = now.year + '-' + now.month + '-' + now.day;
  var hms = p2(Number(t.hour) % 24) + ':' + t.minute + ':' + t.second;
  if (!short) return ymd + ' ' + hms;
  return ymd === nowYmd ? hms : (ymd.slice(5) + ' ' + hms);
}
function modelOrder() { return ((D && D.models) || []).map(function(m) { return m.model; }); }
// 颜色必须由「模型在全局 models 中的序号」决定，不能由当日在 parts 里的下标决定，
// 否则某天只有 model2、另一天只有 model1 时两者会同色
// 颜色由宿主按配色设置算好（D.colors，已校验为 #hex）；缺失时回落官方色阶，避免出现 undefined
// 配色按图各自查表：D.colors[metric] 由宿主算好，面板只取用
function colorsFor(metric) { return ((D && D.colors) || {})[metric] || {}; }
function officialPalette(metric) { return OFFICIAL_COLORS[metric] || OFFICIAL_COLORS.cost; }
function colorOf(model, metric) {
  var map = colorsFor(metric), palette = officialPalette(metric);
  if (map[model]) return map[model];
  var i = modelOrder().indexOf(model);
  return palette[(i >= 0 ? i : palette.length - 1) % palette.length];
}
// 模型在某个口径下的合计：图例按它过滤，口径与宿主聚合一致
function modelMetric(m, metric) {
  if (metric === 'requests') return Number(m.requests) || 0;
  if (metric === 'tokens') return (Number(m.cacheHit) || 0) + (Number(m.cacheMiss) || 0) + (Number(m.output) || 0);
  return Number((m.costBy || {})[usageCurrency()]) || 0;   // 消费金额按当前展示币种
}
function metricLabel(metric) {
  var L = i18n();
  if (metric === 'requests') return L.apiRequests;
  if (metric === 'tokens') return L.tokens;
  return L.costAmount;
}

// 配色设置：宿主已校验并算好最终颜色，这里只读
function chartCfg(metric) {
  var all = (D && D.chart) || {};
  return all[metric] || { mode: 'official', modelColors: {}, baseColor: officialPalette(metric)[0] };
}

// input[type=color] 只接受 #rrggbb；把 3/4 位简写补全，带 alpha 的丢掉 alpha
function toColorInput(v) {
  var s = String(v || '');
  if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  if (/^#[0-9a-f]{4}$/i.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  if (/^#[0-9a-f]{8}$/i.test(s)) return s.slice(0, 7);
  return /^#[0-9a-f]{6}$/i.test(s) ? s : officialPalette(colorPanelMetric)[0];
}

// 配色浮层：模式三选 +（按模型指定时）每个模型一个取色器 + 主色 + 恢复官方。
// 元素逐个 createElement 并绑事件（面板无 CSP nonce，不使用内联 onclick）
// 浮层一次只服务一张图：colorPanelMetric 记录当前图表（三张图的配色互不影响）
var colorPanelMetric = 'cost';

function renderColorPanel() {
  var el = document.getElementById('colorPanel'); if (!el) return;
  var metric = colorPanelMetric;
  var L = i18n(), cfg = chartCfg(metric);
  el.innerHTML = '';

  var head = document.createElement('div'); head.className = 'cp-head';
  var title = document.createElement('div');
  title.className = 'cp-title'; title.textContent = L.chartColorsBtn + ' · ' + metricLabel(metric);
  var close = document.createElement('button');
  close.className = 'cp-close'; close.textContent = '✕'; close.title = L.colorClose;
  close.addEventListener('click', function() { el.hidden = true; });
  head.appendChild(title); head.appendChild(close); el.appendChild(head);

  [['official', L.colorModeOfficial], ['model', L.colorModeModel], ['mono', L.colorModeMono]].forEach(function(m) {
    var row = document.createElement('label'); row.className = 'cp-row';
    var radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'cpMode'; radio.value = m[0]; radio.checked = cfg.mode === m[0];
    radio.addEventListener('change', function() { if (radio.checked) post('setChartColors', { metric: metric, mode: m[0] }); });
    var name = document.createElement('span'); name.textContent = m[1];
    row.appendChild(radio); row.appendChild(name); el.appendChild(row);
  });

  if (cfg.mode === 'model') {
    modelOrder().forEach(function(model) {
      var row = document.createElement('label'); row.className = 'cp-row';
      var picker = document.createElement('input');
      picker.type = 'color'; picker.className = 'cp-color'; picker.value = toColorInput(colorOf(model, metric));
      picker.addEventListener('change', function() { post('setChartColors', { metric: metric, model: model, color: picker.value }); });
      var name = document.createElement('span'); name.className = 'cp-name'; name.textContent = model;
      row.appendChild(picker); row.appendChild(name); el.appendChild(row);
    });
  } else if (cfg.mode === 'mono') {
    var row2 = document.createElement('label'); row2.className = 'cp-row';
    var base = document.createElement('input');
    base.type = 'color'; base.value = toColorInput(cfg.baseColor);
    base.addEventListener('change', function() { post('setChartColors', { metric: metric, color: base.value }); });
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
// Tokens 轴用 K/M/B 缩写：原文过长会压缩绘图区宽度（官网也是 0 / 180M / 360M）
function fmtAxisCompact(v) {
  var abs = Math.abs(v);
  if (!(abs > 0)) return '0';
  var units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (var i = 0; i < units.length; i++) {
    if (abs >= units[i][0]) {
      var n = abs / units[i][0];
      return (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + units[i][1];
    }
  }
  return String(Math.round(abs));
}
function fmtAxisByMetric(metric, v) {
  if (metric === 'tokens') return fmtAxisCompact(v);
  if (metric === 'requests') return fmtInt(v);
  return fmtAxis(v);
}
function drawEmpty(ctx, w, h, text) {
  ctx.fillStyle = labelColor(); ctx.font = Math.round(12 * FONT_SCALE) + 'px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text || '', w / 2, h / 2);
  ctx.textBaseline = 'alphabetic';
}

// ===== STACKED BAR CHARTS（消费 / 请求次数 / Tokens 三张，同色按模型叠加）=====
// 三张图共用同一套绘制逻辑，只有取哪一列和轴标签格式不同；每张图按自己的
// 配色配置取色（官方色阶按图区分，同一模型在不同图里的颜色可能不同）
var CHART_DEFS = [
  { canvas: 'costChart', wrap: 'costWrap', metric: 'cost', btn: 'colorBtnCost', legend: 'costLegend' },
  { canvas: 'reqChart', wrap: 'reqWrap', metric: 'requests', btn: 'colorBtnReq', legend: 'reqLegend' },
  { canvas: 'tokChart', wrap: 'tokWrap', metric: 'tokens', btn: 'colorBtnTok', legend: 'tokLegend' },
];

// 金额只跟货币代码，不用符号：CNY / JPY 都是 ¥，符号映射本身有歧义；
// 代码取自接口返回的 currency 字段（余额与用量都是），不会猜错
function moneyText(v, currency) {
  return fmtCost(v) + (currency ? ' ' + currency : '');
}
function moneyPair(value, currency) {
  return '<span class="value">' + fmtCost(value) + '</span>' + (currency ? '<span class="suffix">' + esc(currency) + '</span>' : '');
}
// 多币种账户：逐项列出并用 + 连接
function moneyGroup(items) {
  return (items || []).map(function(it) { return moneyPair(it.value, it.currency); }).join('<span class="plus">+</span>');
}
function setHtml(id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; }
// 当前展示币种：默认取载荷提供的（账户主币种），用户在下拉里切换后以本地选择为准
var panelCurrency = null;
function usageCurrency() {
  if (panelCurrency && D && Array.isArray(D.currencies) && D.currencies.indexOf(panelCurrency) >= 0) return panelCurrency;
  return (D && D.currency) || '';
}

// 口径格式化：金额跟着币种代码，其余两个用千分位整数（与官网卡片、浮层一致）
function fmtMetric(metric, v) {
  return metric === 'cost' ? moneyText(v, usageCurrency()) : fmtInt(v);
}
// 一根柱子在某个口径下的值：消费金额按当前币种取，其余两个直接取数
function barValue(bar, metric, currency) {
  if (metric === 'cost') return Number((bar.costBy || {})[currency]) || 0;
  return Number(bar[metric]) || 0;
}
function fmtPercent(hit, miss) {
  var total = hit + miss;
  return total > 0 ? (hit / total * 100).toFixed(1) + '%' : '—';
}
function tipSubRow(label, value) {
  return '<div class="tip-row tip-sub"><span>' + esc(label) + '</span><span>' + value + '</span></div>';
}
function tipHtml(b, metric) {
  var rows = '<div class="tip-row tip-head"><span>' + esc(b.tipHead || b.date) + '</span><span>' + fmtMetric(metric, barValue(b, metric, usageCurrency())) + '</span></div>';
  if (metric === 'tokens') {
    // Tokens 图：每个模型给出命中 / 未命中 / 输出与缓存命中率（命中率 = 命中 /（命中+未命中））
    var L = i18n();
    (b.parts || []).forEach(function(p) {
      var total = Number(p.tokens) || 0;
      if (total <= 0) return;
      var hit = Number(p.cacheHit) || 0, miss = Number(p.cacheMiss) || 0, out = Number(p.output) || 0;
      rows += '<div class="tip-row tip-model"><span><i class="tip-dot" style="background:' + colorOf(p.model, metric) + '"></i>' + esc(p.model) + '</span><span>' + fmtInt(total) + '</span></div>';
      rows += tipSubRow(L.tokenCacheHit, fmtInt(hit));
      rows += tipSubRow(L.tokenCacheMiss, fmtInt(miss));
      rows += tipSubRow(L.tokenOutput, fmtInt(out));
      rows += tipSubRow(L.tokenCacheRate, fmtPercent(hit, miss));
    });
    return rows;
  }
  (b.parts || []).forEach(function(p) {
    var v = metric === 'cost' ? (Number((p.costBy || {})[usageCurrency()]) || 0) : (Number(p[metric]) || 0);
    if (v <= 0) return;   // 该口径为 0 的模型不在这一图里出现
    rows += '<div class="tip-row"><span><i class="tip-dot" style="background:' + colorOf(p.model, metric) + '"></i>' + esc(p.model) + '</span><span>' + fmtMetric(metric, v) + '</span></div>';
  });
  return rows;
}

function drawBars(canvas, bars, metric) {
  try {
    var ctx = getCtx(canvas.id); if (!ctx) return;
    var w = canvas.cw, h = canvas.ch;
    if (w < 40 || h < 40) return;   // 面板不可见时 getBoundingClientRect 全 0，会让 slot 变成 NaN

    var emptyText = chartEmptyText();
    if (!bars || !bars.length) { drawEmpty(ctx, w, h, emptyText); return; }

    var maxRaw = 0;
    bars.forEach(function(b) { var v = barValue(b, metric, usageCurrency()); if (v > maxRaw) maxRaw = v; });
    if (maxRaw <= 0) { drawEmpty(ctx, w, h, emptyText); return; }

    var fs = function(n) { return Math.round(n * FONT_SCALE); };
    var pad = { top: fs(12), right: fs(16), bottom: fs(26), left: fs(52) };
    var pw = w - pad.left - pad.right, ph = h - pad.top - pad.bottom;
    var n = bars.length, slot = pw / n;
    var barW = Math.max(2, Math.min(18, slot * 0.72));
    var max = niceMax(maxRaw), steps = 4;

    // y 轴网格与刻度
    ctx.font = fs(10) + 'px sans-serif';
    for (var i = 0; i <= steps; i++) {
      var y = pad.top + ph * (1 - i / steps);
      drawHLine(ctx, w, y, undefined, pad.left, w - pad.right);
      ctx.fillStyle = labelColor(); ctx.textAlign = 'right';
      ctx.fillText(fmtAxisByMetric(metric, max * i / steps), pad.left - fs(6), y + fs(3));
    }

    // 柱子 + 按模型堆叠（底部 = models[0]）
    var layout = [];
    bars.forEach(function(b, i) {
      var x = pad.left + i * slot + (slot - barW) / 2;
      var sy = pad.top + ph;
      var parts = b.parts || [];
      parts.forEach(function(p) {
        var pv = metric === 'cost' ? (Number((p.costBy || {})[usageCurrency()]) || 0) : (Number(p[metric]) || 0);
        var sh = ph * (pv / max);
        if (sh <= 0) return;
        sy -= sh;
        ctx.fillStyle = colorOf(p.model, metric);
        ctx.fillRect(x, sy, barW, sh);
      });
      layout.push({ x: pad.left + i * slot, w: slot, bar: b });
    });

    // x 轴刻度：柱数 < 4 时全部显示，否则最多 4 个 —— 在首末之间均匀取点（首末必有），单行标注。
    // 上限再受可用宽度约束，避免面板很窄时几个日期挤在一起
    var maxLabels = Math.max(2, Math.min(4, Math.floor(pw / fs(110))));
    var count = Math.min(n, maxLabels);
    var idxs = [];
    for (var li = 0; li < count; li++) {
      var ix2 = count === 1 ? 0 : Math.round(li * (n - 1) / (count - 1));
      if (idxs.indexOf(ix2) < 0) idxs.push(ix2);
    }
    ctx.textAlign = 'center'; ctx.fillStyle = labelColor(); ctx.font = fs(10) + 'px sans-serif';
    idxs.forEach(function(i2) {
      var labels = bars[i2].label || [];
      var cx = pad.left + i2 * slot + slot / 2;
      for (var k = 0; k < labels.length; k++) ctx.fillText(labels[k], cx, pad.top + ph + fs(14) + k * fs(11));
    });

    // 按格命中（31 根细柱的命中粒度过细）
    canvas.onmousemove = function(e) {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      var mx = (e.clientX - rect.left) * (canvas.cw / rect.width);
      if (mx < pad.left || mx > pad.left + pw) { hideChartTip(); return; }
      var idx = Math.floor((mx - pad.left) / slot);
      if (idx < 0 || idx >= layout.length) { hideChartTip(); return; }
      showChartTip(e, tipHtml(layout[idx].bar, metric));
    };
    canvas.onmouseleave = hideChartTip;
  } catch (e2) { console.error('drawBars:', e2); }
}

// 图表空态文案：未取过数据时是「加载中」；仅在已获取过数据、确认未配置凭证时才提示去配置
function chartEmptyText() {
  var L = i18n();
  if (!D || D.hasCreds == null) return L.loading || '';
  if (D.hasCreds === false) return L.noSessionToken;
  // 只有用量请求本身失败才说加载失败；余额等其它错误不应影响图表的空态
  return (D.usageFailed || (D.usageFailed == null && D.error)) ? L.loadFailed : L.noDataRange;
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
    setText('updatedAt', L.updatedAtLabel.replace('{0}', fmtClock(d.updatedAt, true)));
    document.getElementById('updatedAt').title = fmtClock(d.updatedAt, false) + ' (' + ((D && D.tzLabel) || '') + ')';
  }
  show('updatedAt', !!d.updatedAt);

  // 卡A：充值余额（topped_up_balance，与官方「充值余额」同口径）
  // 赠送金额 > 0 时，今日消费右侧多一张「赠送金额」卡，首行由两列变三列
  var balItems = (d.bal && Array.isArray(d.bal.items)) ? d.bal.items : [];
  var hasGift = !!(d.hasBalance && d.bal) && balItems.some(function(it) { return (it.granted || 0) > 0; });
  if (d.hasBalance && d.bal && balItems.length) {
    setHtml('topupValue', moneyGroup(balItems.map(function(it) { return { value: it.toppedUp, currency: it.currency }; })));
    var subs = [];                                          // 赠送金额不在这里重复：单独有卡
    if (d.bal.insufficient) subs.push(L.balanceInsufficient);
    if (d.keyDegraded) subs.push(L.keySessionOnly);
    setText('topupSub', subs.join(' · '));          // 无内容时不占位（见 .sub[hidden]）
    show('topupSub', subs.length > 0);
  } else {
    setHtml('topupValue', '<span class="value">—</span>');
    setText('topupSub', d.keyDegraded ? (L.errNoApiKey + ' · ' + L.keySessionOnly) : L.errNoApiKey);
    show('topupSub', true);
  }
  if (hasGift) {
    setHtml('giftValue', moneyGroup(balItems
      .filter(function(it) { return (it.granted || 0) > 0; })
      .map(function(it) { return { value: it.granted, currency: it.currency }; })));
  }
  show('giftCard', hasGift);
  var topRow = document.getElementById('topRow');
  if (topRow) topRow.className = hasGift ? 'cards-2 gift' : 'cards-2';   // 三张卡才配三列，否则留白

  // 卡B：消费统计（今日 / 本月 / 累计，由设置 costCard 决定；与图表所选窗口无关）
  var costMode = d.costCard || 'today';
  setText('costStatLabel', costMode === 'month' ? L.monthCostCard : (costMode === 'total' ? L.costCardTotal : L.todayCost));
  if (costMode === 'total') {
    // 累计：账号概览接口按币种返回，和余额卡一样逐项 + 连接
    var totalItems = (d.totalCosts || []).map(function(it) { return { value: it.amount, currency: it.currency }; });
    setHtml('todayValue', totalItems.length ? moneyGroup(totalItems) : '<span class="value">—</span>');
    var totalSub = d.hasCreds === false ? L.noSessionToken : (d.hasTotal ? '' : L.loadFailed);
    setText('todaySub', d.hasCreds == null ? (L.loading || '') : totalSub);
    show('todaySub', !!(d.hasCreds == null || totalSub));
  } else {
    var statVal = costMode === 'month' ? d.monthCost : d.todayCost;
    var statHas = costMode === 'month' ? (d.monthCost != null) : !!d.hasToday;
    setHtml('todayValue', statHas ? moneyPair(statVal, usageCurrency()) : '<span class="value">—</span>');
    setText('todaySub', d.hasCreds == null ? (L.loading || '') : (d.hasCreds ? L.loadFailed : L.noSessionToken));
    show('todaySub', !statHas || d.hasCreds == null);
  }

  // 三张指标卡
  if (d.hasUsage) {
    // 消费金额卡：多币种与账户余额一样逐项用 + 连接（各带自己的代码，不做汇率换算）
    var costBy = d.totalCostBy || {};
    var costItems = Object.keys(costBy).sort()
      .filter(function(cur) { return (Number(costBy[cur]) || 0) > 0; })
      .map(function(cur) { return { value: costBy[cur], currency: cur }; });
    setHtml('mCost', costItems.length ? moneyGroup(costItems) : '<span class="value">0.00</span>');
    setText('mReqs', fmtInt(d.totalReqs));
    setText('mTokens', fmtInt(d.totalTokens));
  } else {
    setHtml('mCost', '<span class="value">—</span>');
    setText('mReqs', '—'); setText('mTokens', '—');
  }

  // 图表卡：合计 + 图例（三张图配色各自独立，图例也就各按各的颜色渲染）
  var cur = usageCurrency();
  setText('tzNote', (d.tzNote || ''));
  setText('chartTotal', d.hasUsage ? moneyText((d.totalCostBy || {})[cur] || 0, cur) : '');
  setText('costCur', cur ? String(L.currencyTag || ' ({0})').replace('{0}', cur) : '');
  syncCurrencySelect();
  setText('reqTotal', d.hasUsage ? fmtInt(d.totalReqs) : '');
  setText('tokTotal', d.hasUsage ? fmtInt(d.totalTokens) : '');
  CHART_DEFS.forEach(function(cd) {
    var el = document.getElementById(cd.legend); if (!el) return;
    var html = '';
    (d.models || []).forEach(function(m) {
      if (modelMetric(m, cd.metric) <= 0) return;
      html += '<span class="legend-item"><i class="legend-dot" style="background:' + colorOf(m.model, cd.metric) + '"></i>' + esc(m.model) + '</span>';
    });
    el.innerHTML = html;
  });
}

// 币种下拉：窗口里出现多个币种时才显示，选项按载荷提供的列表（升序）
function syncCurrencySelect() {
  var sel = document.getElementById('curSelect'); if (!sel) return;
  var list = (D && Array.isArray(D.currencies)) ? D.currencies : [];
  if (list.length <= 1) { sel.hidden = true; sel.innerHTML = ''; return; }
  var html = '';
  list.forEach(function(cur) {
    html += '<option value="' + esc(cur) + '">' + esc(cur) + '</option>';
  });
  sel.innerHTML = html;
  sel.value = usageCurrency();
  sel.hidden = false;
}

// 时间窗口下拉：选项静态内联在外壳里，这里只同步选中值，并挂上区间说明
function syncRanges() {
  var sel = document.getElementById('rangeSelect'); if (!sel || !D || !D.preset) return;
  if (RANGE_IDS.indexOf(D.preset) >= 0 && sel.value !== D.preset) sel.value = D.preset;
  sel.title = D.rangeLabel || '';
}

// 画图：面板首次可见前 canvas 尺寸可能还是 0，用 rAF 重试一次。
// 不能以消费金额图为锚点：charts.items 可能把它关掉，此时其余图仍需绘制。
function drawChart(retried) {
  var first = null;
  CHART_DEFS.forEach(function(cd) {
    if (!first) first = document.getElementById(cd.canvas);
  });
  if (!first) return;
  var r = first.getBoundingClientRect();
  if ((!r.width || !r.height) && !retried) { requestAnimationFrame(function() { drawChart(true); }); return; }
  CHART_DEFS.forEach(function(cd) {
    var canvas = document.getElementById(cd.canvas); if (!canvas) return;
    drawBars(canvas, D && D.hasUsage ? D.bars : [], cd.metric);
  });
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
document.getElementById('costStatCycle').addEventListener('click', function() { post('cycleCostCard'); });
(function() {
  var curSel = document.getElementById('curSelect');   // 没配消费金额图时该元素不存在
  if (!curSel) return;
  curSel.addEventListener('change', function() {
    panelCurrency = this.value;   // 各币种金额都在载荷里：本地重渲染即可，不重新取数
    render();
    drawChart(true);
    hideChartTip();
  });
})();
// 每张图一个「配色」按钮：点开的是自己那张图的配置；再点同一个按钮收起
CHART_DEFS.forEach(function(cd) {
  var btn = document.getElementById(cd.btn); if (!btn) return;
  btn.addEventListener('click', function() {
    var el = document.getElementById('colorPanel'); if (!el) return;
    if (!el.hidden && colorPanelMetric === cd.metric) { el.hidden = true; return; }
    colorPanelMetric = cd.metric;
    renderColorPanel();
    // 浮层贴着被点的按钮展开（按钮在图表卡右上角，位置随窗口宽度变化）
    var r = this.getBoundingClientRect();
    el.style.top = Math.round(r.bottom + 6) + 'px';
    el.style.right = Math.max(12, Math.round(window.innerWidth - r.right)) + 'px';
    el.hidden = false;
  });
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
CHART_DEFS.forEach(function(cd) {
  var wrap = document.getElementById(cd.wrap);
  if (wrap) ro.observe(wrap);   // 未配置的图没有 DOM：observe(undefined) 会抛错，整个面板脚本会中止
});

// 首屏 — 占位，三张图都显示"加载中"，等待扩展推送数据；时区说明先按外壳注入的时区填一次
setText('tzNote', String(I18N.tzNote || '').replace('{0}', TZ_LABEL));
(function() {
  CHART_DEFS.forEach(function(cd) {
    var c = document.getElementById(cd.canvas); if (!c) return;
    var ctx = getCtx(c.id);
    if (ctx) drawEmpty(ctx, c.cw, c.ch, I18N.loading || '');
  });
})();
syncRanges();
// 上报客户端时区：宿主在 auto 模式下采用（扩展运行在远端，宿主无法获取客户端时区）
try { post('clientZone', { zone: Intl.DateTimeFormat().resolvedOptions().timeZone }); } catch (e) {}
post('ready');
})();
</script></body></html>`;
  // 字号缩放：CSS 里的 px 字号/行高统一乘系数；canvas 侧由脚本里的 FONT_SCALE 处理
  const scale = Number.isFinite(fontScale) ? fontScale : 1;
  return html
    .replace('<style>', '<style>\nhtml{--fs:' + scale + '}')
    .replace(/font-size:(\d+(?:\.\d+)?)px/g, 'font-size:calc($1px * var(--fs))')
    .replace(/line-height:(\d+(?:\.\d+)?)px/g, 'line-height:calc($1px * var(--fs))');
}

// ============================================================
//  Extension Activation
// ============================================================

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  const i18n = t();
  const config = () => vscode.workspace.getConfiguration('deepseek-usage-monitor');
  const langKey = () => config().get('language', 'zh-cn');

  // 时区：设置项（任意 IANA 名 / GMT±N）优先；留空 = 跟随客户端（面板上报并存 globalState）；最后回落 UTC+8
  let tzWarned = false;
  function resolveZone() {
    const raw = config().get('timezone', '');
    if (String(raw == null ? '' : raw).trim()) {
      const norm = normalizeZone(raw);
      if (norm) return setActiveZone(norm);
      if (!tzWarned) { tzWarned = true; vscode.window.showWarningMessage(tf('tzInvalid', raw)); }
    }
    const stored = normalizeZone(context.globalState.get(TZ_CLIENT_KEY, ''));
    if (stored) return setActiveZone(stored);
    return setActiveZone(DEFAULT_ZONE);
  }
  resolveZone();

  // 配色：设置项 chartColors 是唯一真源（可随设置同步/配置导出迁移）；
  // 老版本的 globalState 配置在激活时迁移一次并清掉，避免两处真源
  function chartColorSetting() { return config().get('chartColors', {}) || {}; }
  function legacyChartColorState() {
    const gs = context.globalState;
    const three = gs.get(CHART_COLORS_KEY, null);
    if (three && typeof three === 'object') return three;
    const mode = gs.get(CHART_LEGACY_KEYS.mode, '');
    const map = gs.get(CHART_LEGACY_KEYS.modelColors, {}) || {};
    const base = gs.get(CHART_LEGACY_KEYS.baseColor, '');
    if (!mode && !base && !Object.keys(map).length) return null;
    return { cost: { mode, modelColors: map, baseColor: base } };
  }
  async function migrateChartColors() {
    if (Object.keys(chartColorSetting()).length) return;
    const legacy = legacyChartColorState();
    if (!legacy) return;
    await config().update('chartColors', resolveChartConfigs(legacy, null), vscode.ConfigurationTarget.Global);
    await context.globalState.update(CHART_COLORS_KEY, undefined);
    await context.globalState.update(CHART_LEGACY_KEYS.mode, undefined);
    await context.globalState.update(CHART_LEGACY_KEYS.modelColors, undefined);
    await context.globalState.update(CHART_LEGACY_KEYS.baseColor, undefined);
  }
  migrateChartColors().catch(() => {});

  // ---- Status bar ----
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
  // 状态栏点击的行为由 statusBar.closeWhenActive 决定；命令面板的「打开面板」始终只开/聚焦
  statusBarItem.command = { command: 'deepseek-usage-monitor.statusBarClick', title: i18n.title };
  statusBarItem.text = statusText('$(sync~spin)');   // 加载态；名称已按 statusBar.label 取
  statusBarItem.tooltip = i18n.loading;
  statusBarItem.show();

  // ---- Config ----
  // secrets 读取：带超时回退 + 内存缓存（详见文件顶部注释）
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
  // hasCreds 初始为 null（未知）：首次刷新返回前不能断言「未配置凭证」，
  // 否则面板一连上就会把占位载荷渲染成「请在设置中配置…」
  let latestData = { balance: null, usage: null, month: null, hasCreds: null, error: null, errorText: null, usageFailed: false, totalCosts: [], hasTotal: false };
  let lastUpdatedAt = null;   // 最近一次成功取到数据的时刻（面板显示"数据更新时间"）
  // 面板时间窗口：读取持久化值，非法或已删除的 id 一律回落默认预设
  let currentPreset = (() => { const v = context.globalState.get(PRESET_STATE_KEY); return isPreset(v) ? v : DEFAULT_PRESET; })();
  function savePreset(id) { Promise.resolve(context.globalState.update(PRESET_STATE_KEY, id)).catch(() => {}); }
  let refreshInFlight = null;   // 进行中的刷新 Promise；null = 空闲
  let refreshQueued = null;     // 执行期间到达的刷新请求，仅保留最后一次，结束后补执行；用于串行化，避免并发写 latestData 与重复请求
  let refreshBusy = false;      // 刷新状态标志

  // 用窗口区间取用量；结构无法识别时如实报错，不做静默回退
  async function fetchUsageSpec(sessionToken, cookie, proxy, spec, nowMs) {
    const { amount, cost } = await fetchUsageRange(sessionToken, cookie, proxy, spec.startSec, spec.endSec);
    const agg = aggregateUsageRange(amount, cost, spec, nowMs);
    if (!agg) throw new Error('Invalid response (unrecognized usage payload)');
    return agg;
  }

  // 与窗口无关的本月快照。优先用独立拉取的本月窗口；窗口恰好从本月 1 日开始时可复用其合计；
  // 其余情形（昨天 / 上月 / 跨上月的近 7·30 天）本月合计另取，今日值则在日粒度的最后一根柱子上读取。
  function buildMonthSnapshot({ monthAgg, windowAgg, spec, nowMs, currency }) {
    const costOf = (bar) => ((bar && bar.costBy ? bar.costBy[currency] : 0) || 0);
    const now = nowMs == null ? Date.now() : nowMs;
    const t8 = zoneParts(Math.floor(now / 1000));
    const todayDate = `${pad2(t8.month)}-${pad2(t8.day)}`;
    const lastOf = (agg) => (agg && agg.bars.length ? agg.bars[agg.bars.length - 1] : null);
    if (monthAgg) {
      const bar = lastOf(monthAgg);   // 本月窗口的最后一根即今天
      return { totalCost: (monthAgg.totalCostBy || {})[currency] || 0, todayCost: costOf(bar), todayTokens: bar ? bar.tokens : 0 };
    }
    if (!windowAgg) return null;
    if (coversMonthToDate(spec, now)) {
      const bar = lastOf(windowAgg);
      return { totalCost: (windowAgg.totalCostBy || {})[currency] || 0, todayCost: costOf(bar), todayTokens: bar ? bar.tokens : 0 };
    }
    if (spec.id === 'today') {
      return { totalCost: null, todayCost: (windowAgg.totalCostBy || {})[currency] || 0, todayTokens: windowAgg.totalTokens };
    }
    if (spec.granularity === 'day') {
      const bar = lastOf(windowAgg);
      if (bar && bar.date === todayDate) return { totalCost: null, todayCost: costOf(bar), todayTokens: bar.tokens };
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
    const wantTotal = currentCostCard === 'total';
    latestData = { balance: null, usage: null, month: null, hasCreds, error: null, errorText: null, usageFailed: false, totalCosts: [], hasTotal: false };

    const results = await Promise.allSettled([
      cfg.apiKey ? fetchBalance(cfg.apiKey) : Promise.reject(new Error('no-api-key')),
      hasCreds ? fetchUsageSpec(cfg.sessionToken, cfg.cookie, cfg.proxy, spec, now) : Promise.reject(new Error('no-session')),
      needMonth ? fetchUsageSpec(cfg.sessionToken, cfg.cookie, cfg.proxy, resolveRange('thisMonth', now), now) : Promise.resolve(null),
      // 只在卡片设为「累计消费」时才额外打这个接口（顺带也用于将来的余额来源）
      (wantTotal && hasCreds) ? fetchPlatformApi(cfg.sessionToken, cfg.cookie, cfg.proxy, '/api/v0/users/get_user_summary') : Promise.resolve(null),
    ]);

    const errors = [];
    const pushErr = (scope, m) => { if (!errors.some(([sc, mm]) => sc === scope && mm === m)) errors.push([scope, m]); };
    if (results[0].status === 'fulfilled') latestData.balance = results[0].value;
    else if (results[0].reason.message !== 'no-api-key') pushErr('Balance', results[0].reason.message);
    if (results[1].status === 'fulfilled') latestData.usage = results[1].value;
    else if (results[1].reason.message !== 'no-session') {
      latestData.usageFailed = true;   // 仅用量窗口失败；余额失败不影响图表的空态文案
      pushErr('Usage', results[1].reason.message);
    }
    const monthAgg = results[2].status === 'fulfilled' ? results[2].value : null;
    if (results[2].status === 'rejected' && needMonth) pushErr('Usage', results[2].reason.message);
    const summary = results[3].status === 'fulfilled' ? results[3].value : null;
    if (results[3].status === 'rejected' && wantTotal && hasCreds) pushErr('Usage', results[3].reason.message);
    latestData.totalCosts = summary ? parseTotalCosts(summary) : [];
    latestData.hasTotal = hasSummaryData(summary);
    // 展示币种：优先账户主币种（余额第一项），否则用量里的第一个；面板可临时切换
    const balItems = parseBalanceItems(latestData.balance);
    // 窗口里没有金额数据时（比如上月）退回本月快照的币种列表，避免展示币种变成空
    const currencySource = (latestData.usage && latestData.usage.currencies.length) ? latestData.usage : (monthAgg || latestData.usage);
    latestData.currency = pickDisplayCurrency(balItems, currencySource);
    latestData.month = buildMonthSnapshot({ monthAgg, windowAgg: latestData.usage, spec, now, currency: latestData.currency });
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
      // 异常处理：刷新流程本身抛异常（非接口错误）时同样给出两份文案，避免 errorText 残留上一次的
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
  // 金额只带货币代码（不用符号：CNY/JPY 都是 ¥，映射表本身有歧义）
  const moneyText = (v, currency) => (v == null ? '—' : `${v}${currency ? ' ' + currency : ''}`);
  const fmtCost2 = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : null);
  const fmtMoney = (label, v, currency) => `${label}:${moneyText(v, currency)}`;
  const fmtThousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  // 状态栏里的名称部分（默认 DeepSeek Usage，可由 statusBar.label 覆盖为任意文本）。
  // 去掉换行与制表符：状态栏是单行文本，换行会把图标与数据挤到第二行；
  // 允许留空 —— 此时只显示图标与数据，不显示名称。
  function statusLabel() {
    const raw = config().get('statusBar.label', SB_LABEL_DEFAULT);
    const s = String(raw == null ? '' : raw).replace(/[\r\n\t]+/g, ' ').trim();
    return Array.from(s).slice(0, SB_LABEL_MAX).join('');   // 直接改 settings.json 时也遵守长度上限
  }

  // 拼接状态栏文本：[图标, 名称, 数据] 中为空的部分自动省略，避免多余空格
  function statusText(icon, rest) {
    return [icon, statusLabel(), rest].filter(Boolean).join(' ');
  }

  // 面板字号缩放比例：0.8–1.4，非法值回落 1
  function panelFontScale() {
    const n = Number(config().get('dashboard.fontScale', 1));
    return Number.isFinite(n) ? Math.round(Math.max(0.8, Math.min(1.4, n)) * 100) / 100 : 1;
  }

  // 首行消费统计卡显示内容：today / month / total（累计）。与时间范围一样存 globalState，
  // 面板重建 / Reload 后恢复；不随设置项迁移
  const COST_CARD_ORDER = ['today', 'month', 'total'];
  function readCostCard() {
    const v = String(context.globalState.get(COST_CARD_KEY, '') || '');
    return COST_CARD_ORDER.indexOf(v) >= 0 ? v : 'today';
  }
  let currentCostCard = readCostCard();
  async function cycleCostCard() {
    currentCostCard = COST_CARD_ORDER[(COST_CARD_ORDER.indexOf(currentCostCard) + 1) % COST_CARD_ORDER.length];
    await context.globalState.update(COST_CARD_KEY, currentCostCard);
    if (currentCostCard === 'total' && !latestData.hasTotal) await fetchTotalCosts();
    pushData();
  }
  // 只补拉账号概览（累计消费），不动其它数据：切换卡片时不重新取用量
  async function fetchTotalCosts() {
    const cfg = await getConfig();
    if (!cfg.sessionToken || !cfg.cookie) { latestData.totalCosts = []; latestData.hasTotal = false; return; }
    try {
      const json = await fetchPlatformApi(cfg.sessionToken, cfg.cookie, cfg.proxy, '/api/v0/users/get_user_summary');
      latestData.totalCosts = parseTotalCosts(json);
      latestData.hasTotal = hasSummaryData(json);
    } catch (e) {
      latestData.totalCosts = [];
      latestData.hasTotal = false;
    }
  }

  // 面板图表：在列即显示、数组顺序即面板顺序；留空则不显示任何图表
  function chartItems() {
    const configured = config().get('charts.items', CHART_METRICS);
    const list = Array.isArray(configured) ? configured : CHART_METRICS;
    return Array.from(new Set(list.filter((v) => CHART_METRICS.indexOf(v) >= 0)));
  }

  function buildStatusSegments({ today, cost, usageCurrency, balItems, todayTokens }) {
    const i18n = t();
    const configured = config().get('statusBar.items', SB_DEFAULT_ITEMS);
    const items = Array.isArray(configured) ? configured : SB_DEFAULT_ITEMS;
    const segs = [];
    // 余额可能多币种：逐项列出并用 + 连接（与面板卡片一致）
    const balText = (Array.isArray(balItems) && balItems.length)
      ? balItems.map((it) => moneyText(fmtCost2(it.total), it.currency)).join(' + ')
      : '—';
    for (const item of items) {
      if (item === 'todayCost') segs.push(fmtMoney(i18n.sbTodayCost, today, usageCurrency));
      else if (item === 'monthCost') segs.push(fmtMoney(i18n.sbMonthCost, cost, usageCurrency));
      else if (item === 'balance') segs.push(`${i18n.sbBalance}:${balText}`);
      else if (item === 'todayTokens') segs.push(`${i18n.sbTodayTokens} ${todayTokens == null ? '—' : fmtThousands(todayTokens)} ${i18n.tokens}`);
    }
    return segs;
  }

  function updateStatusBar() {
    const { balance, usage, month, error, errorText } = latestData;
    if (error) { statusBarItem.text = statusText('$(error)'); statusBarItem.tooltip = errorText ? `${errorText}\n(${error})` : error; statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground'); return; }
    const balItems = parseBalanceItems(balance);
    // 状态栏的"本月/本日"恒为当前月与今天，与面板所选窗口无关
    const cost = month && month.totalCost != null ? month.totalCost.toFixed(2) : null;
    const today = month && month.todayCost != null ? month.todayCost.toFixed(2) : null;
    const todayTokens = month && month.todayTokens != null ? month.todayTokens : null;
    const usageCurrency = latestData.currency || '';

    // 未配置任何凭证时保留引导，避免状态栏显示一长串 —
    if (!balItems.length && !month && !usage) {
      statusBarItem.text = statusText('$(key)');
      statusBarItem.tooltip = keyDegraded ? `${t().errNoApiKey}\n${t().keySessionOnly}` : t().errNoApiKey;
      statusBarItem.backgroundColor = undefined;
      return;
    }

    const segs = buildStatusSegments({ today, cost, usageCurrency, balItems, todayTokens });
    statusBarItem.text = statusText('$(credit-card)', segs.length ? segs.join(' | ') : '');
    const balLine = balItems.length
      ? balItems.map((it) => moneyText(fmtCost2(it.total), it.currency)).join(' + ')
      : '—';
    statusBarItem.tooltip = `${t().sbMonthCost}: ${moneyText(cost, usageCurrency)} | ${t().sbTodayCost}: ${moneyText(today, usageCurrency)} | ${t().sbBalance}: ${balLine}\n${t().clickDetails}`
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
    const cfgs = resolveChartConfigs(chartColorSetting());
    const spec = resolveRange(currentPreset);
    const balItems = parseBalanceItems(balance);
    const bal = balItems.length ? {
      items: balItems,   // 每项一个币种，面板逐项展示（用 + 连接），不做汇率换算
      // is_available 是"余额是否足以继续调用 API"的标志，为 false 时数字仍然有效，只降级成一行提示
      insufficient: balance.is_available === false,
    } : null;
    return {
      i18n: t(),
      preset: currentPreset,                        // 六个预设 id 之一
      rangeLabel: fmtRangeLabel(spec),              // 悬停下拉时显示具体区间
      rangeStart: spec.startSec, rangeEnd: spec.endSec,
      tzZone: activeZone,                                                       // 展示/分桶时区（IANA 名）
      tzLabel: zoneGmtLabel(Math.floor(Date.now() / 1000)),                     // 当前偏移（GMT+8 / GMT+5:30）
      tzNote: String(t().tzNote || '').replace('{0}', zoneGmtLabel(Math.floor(Date.now() / 1000))),
      costCard: currentCostCard,                                                // 首行消费统计卡：today / month / total
      totalCosts: latestData.totalCosts || [],                                 // 累计消费（按币种，仅 total 模式会拉）
      hasTotal: !!latestData.hasTotal,
      currency: latestData.currency || '',                                      // 默认展示币种（面板可切换）
      currencies: usage ? usage.currencies : [],                               // 用量窗口里出现过的币种（>1 时面板出币种下拉）
      totalCostBy: usage ? usage.totalCostBy : {},                             // 各币种合计：消费金额卡逐项用 + 连接
      totalCost: usage ? ((usage.totalCostBy || {})[latestData.currency] || 0) : 0,   // 默认币种合计（状态栏/兼容）
      granularity: usage ? usage.granularity : spec.granularity,   // 失败时仍按预设，空图坐标轴才正确
      bucket: usage ? usage.spec.slotSec : spec.slotSec,
      busy: refreshBusy,
      keyDegraded,
      error: error || null,
      errorText: errorText || null,
      usageFailed: !!latestData.usageFailed,   // 图表的空态区分"用量请求失败"与"该窗口无数据"
      updatedAt: lastUpdatedAt,
      hasBalance: !!bal, bal,
      hasCreds,                                     // 区分"没配凭证"与"拉取失败"
      hasUsage: !!usage,
      models: usage ? usage.models : [], bars: usage ? usage.bars : [],
      chart: cfgs,                                                              // 三张图各自的配色控件状态（模式/主色/按模型覆盖）
      colors: chartColorsAll(cfgs, usage ? usage.models.map((m) => m.model) : []), // 每张图已解析的最终颜色，面板只查表
      totalTokens: usage ? usage.totalTokens : 0, totalReqs: usage ? usage.totalReqs : 0,
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
    currentPanel.webview.html = buildPanelHtml(t(), langKey(), currentPreset, resolveBackground(context, currentPanel.webview), chartItems(), panelFontScale());
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
    currentPanel.webview.html = buildPanelHtml(t(), langKey(), currentPreset, resolveBackground(context, currentPanel.webview), chartItems(), panelFontScale());

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
        } else if (msg.type === 'cycleCostCard') {
          await cycleCostCard();                   // 卡片右上角按钮：today → month → total → today
        } else if (msg.type === 'clientZone') {
          // 仅 auto 模式（设置为空）下采用客户端时区；变了才重新取数
          const z = normalizeZone(msg.zone);
          if (z && !String(config().get('timezone', '') || '').trim()) {
            await context.globalState.update(TZ_CLIENT_KEY, z);
            const before = activeZone;
            setActiveZone(z);
            if (activeZone !== before) refresh(undefined, 'client-timezone');
          }
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
    const ms = refreshIntervalMs(config().get('refreshInterval', 1));
    if (!ms) return;
    refreshTimer = setInterval(() => refresh(undefined, 'auto'), ms);
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
        defaultUri: vscode.Uri.file(localDialogDir()),   // file: → 客户端原生对话框（远程窗口也一样）
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
  // 面板配色控件写回设置项 chartColors（可迁移）。只影响渲染：不重建外壳、不重取数据。
  // 指定单个模型的颜色即隐含切到「按模型指定」，否则界面上看不到变化。
  async function applyChartColors(msg) {
    const metric = CHART_METRICS.indexOf(String(msg.metric || '')) >= 0 ? String(msg.metric) : 'cost';
    const all = Object.assign({}, chartColorSetting());
    const next = sanitizeChartConfig(all[metric]);
    const mode = String(msg.mode || '');
    if (CHART_COLOR_MODES.indexOf(mode) >= 0) next.mode = mode;
    const color = sanitizeChartColor(msg.color);
    if (color && msg.model) {
      next.modelColors = Object.assign({}, next.modelColors, { [String(msg.model)]: color });
      // 指定单个模型的颜色即隐含切到「按模型指定」，否则界面上看不到变化
      if (next.mode !== 'model') next.mode = 'model';
    } else if (color) {
      next.baseColor = color;
    }
    all[metric] = next;
    await config().update('chartColors', all, vscode.ConfigurationTarget.Global);
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
      // 扩展以 UI 扩展运行（extensionKind: ui）：默认保存到本机用户目录。
      // 工作区路径在远程窗口里属于远端文件系统，本机宿主无法直接写入
      target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'deepseek-usage-config.json')),
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
        canSelectMany: false, openLabel: t().importConfigTitle,
        defaultUri: vscode.Uri.file(localDialogDir()),     // 同上：避免远程窗口打开远端目录
        filters: { JSON: ['json'] },
      });
    } catch (e) { picked = undefined; }
    if (!picked || !picked.length) return;

    const file = String(picked[0].fsPath || '');
    let parsed;
    try {
      // 部分编辑器写出的 UTF-8 文件带 BOM；JSON.parse 会把它当成非法字符
      parsed = JSON.parse(String(fs.readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''));
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

    // 旧格式兼容：配色曾存在 state（deepseekUsage.chartColors / chartColorMode…），折算成设置项
    if (!Object.prototype.hasOwnProperty.call(apply, 'chartColors')) {
      const legacyColors = stateApply[CHART_COLORS_KEY]
        || (stateApply[CHART_LEGACY_KEYS.mode] || stateApply[CHART_LEGACY_KEYS.baseColor]
            || Object.keys(stateApply[CHART_LEGACY_KEYS.modelColors] || {}).length
          ? { cost: {
              mode: stateApply[CHART_LEGACY_KEYS.mode],
              modelColors: stateApply[CHART_LEGACY_KEYS.modelColors],
              baseColor: stateApply[CHART_LEGACY_KEYS.baseColor],
            } }
          : null);
      if (legacyColors) apply.chartColors = sanitizeConfigSetting('chartColors', legacyColors);
      // 这些老键不再写回状态（真源已移到设置项）
      delete stateApply[CHART_COLORS_KEY];
      delete stateApply[CHART_LEGACY_KEYS.mode];
      delete stateApply[CHART_LEGACY_KEYS.modelColors];
      delete stateApply[CHART_LEGACY_KEYS.baseColor];
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
    // 内部命令：仅供状态栏点击使用，不在 package.json 里声明（因此不出现在命令面板）
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
      const dashChanged = e.affectsConfiguration('deepseek-usage-monitor.dashboard');
      const chartsChanged = e.affectsConfiguration('deepseek-usage-monitor.charts');
      if (dashChanged && currentPanel) rebuildShell();
      if (chartsChanged && currentPanel) rebuildShell();
      if (e.affectsConfiguration('deepseek-usage-monitor.timezone')) resolveZone();
      // 只有配色变化：重渲染即可，不必重新取数
      const colorsOnly = e.affectsConfiguration('deepseek-usage-monitor.chartColors')
        && !['sessionToken', 'cookie', 'proxy', 'language', 'statusBar', 'refreshInterval', 'dashboard', 'charts', 'timezone']
          .some((k) => e.affectsConfiguration('deepseek-usage-monitor.' + k));
      if (colorsOnly) { pushData(); return; }
      // 纯外观变化（字号、背景、图表开关）只需重建外壳，数据与载荷不变，不重新取数
      const appearanceOnly = (dashChanged || chartsChanged)
        && !['sessionToken', 'cookie', 'proxy', 'language', 'statusBar', 'refreshInterval', 'timezone', 'chartColors']
          .some((k) => e.affectsConfiguration('deepseek-usage-monitor.' + k));
      if (appearanceOnly) return;
      refresh(undefined, 'config');
    }),
    statusBarItem
  );

  // Init —— 首刷不阻塞 activate()：网络慢时会让扩展激活挂起数秒（请求超时上限 15s），状态栏先显示加载态即可
  refresh(undefined, 'init');
  // 自动刷新不带 preset：refresh 省略该参数时沿用 currentPreset（用户所选窗口）
  startAutoRefresh();
  context.subscriptions.push({ dispose: stopAutoRefresh });
  console.log('[DeepSeek Usage Monitor] Activated (+' + (Date.now() - LOADED_AT) + 'ms since load)');
}

function deactivate() { console.log('[DeepSeek Usage Monitor] Deactivated'); }
module.exports = { activate, deactivate, __test: {
  resolveRange, slotStartSec, visibleSlotCount, coversMonthToDate, bucketSecOf,
  seriesOf, seriesGroups, pickDisplayCurrency, parseBalanceItems,
  parseTotalCosts, normalizeZone, zoneParts, zoneOffsetSec, zoneDayStartSec, zoneDayStartSecOf, zoneHourStartSec,
  zoneGmtLabel, zoneOffsetLabel, setActiveZone, DEFAULT_ZONE,
  aggregateUsageRange, fmtRangeLabel, RANGE_PRESET_DEFS, DEFAULT_PRESET,
  sanitizeBgValue, bgSafeName, bgImagePath, resolveBackground, buildPanelHtml,
  sanitizeChartColor, hexToHsl, hslToHex, colorLadder, resolveChartConfigs, sanitizeChartConfig, chartColorsAll, chartColorMap, OFFICIAL_COLORS,
  sanitizeConfigSetting, sanitizeConfigState, CONFIG_SETTING_KEYS, CONFIG_STATE_KEYS,
  refreshIntervalMs,
} };
