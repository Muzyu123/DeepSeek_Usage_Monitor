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
    todayCurrentMonthOnly: 'Current month only',
    costAmount: 'Cost',
    costCny: 'Cost (CNY)',
    apiRequests: 'API requests',
    tokens: 'Tokens',
    monthLabel: 'Month',
    updatedAtLabel: 'Updated {0}',
    loading: 'Loading...', refresh: 'Refresh',
    settings: '⚙ Settings', setApiKey: 'Set API Key',
    sbTodayCost: 'Today', sbMonthCost: 'Month', sbBalance: 'Balance', sbTodayTokens: 'Today',
    noSessionToken: 'Configure Session Token & Cookie',
    errNoApiKey: 'Set API Key',
    noDataThisMonth: 'No cost data this month',
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
    checkSessionToken: 'check session token / network',
    loadMonthFailed: 'DeepSeek Usage: failed to load {0} — {1}',
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
    todayCurrentMonthOnly: '仅当月可用',
    costAmount: '消费金额',
    costCny: '消费金额（CNY）',
    apiRequests: 'API 请求次数',
    tokens: 'Tokens',
    monthLabel: '月份',
    updatedAtLabel: '数据更新时间 {0}',
    loading: '加载中...', refresh: '刷新',
    settings: '⚙ 设置', setApiKey: '设置 API Key',
    sbTodayCost: '本日消费', sbMonthCost: '本月消费', sbBalance: '账户余额', sbTodayTokens: '本日消耗',
    noSessionToken: '请在设置中配置 Session Token 和 Cookie',
    errNoApiKey: '请设置 API Key',
    noDataThisMonth: '本月暂无消费数据',
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
    checkSessionToken: '请检查 Session Token 与网络',
    loadMonthFailed: 'DeepSeek Usage：加载 {0} 失败 — {1}',
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

async function fetchMonthData(sessionToken, cookie, proxy, month, year) {
  const [amountData, costData] = await Promise.all([
    fetchPlatformApi(sessionToken, cookie, proxy, `/api/v0/usage/amount?month=${month}&year=${year}`),
    fetchPlatformApi(sessionToken, cookie, proxy, `/api/v0/usage/cost?month=${month}&year=${year}`),
  ]);
  return aggregateUsage(amountData, costData, year, month);
}

// ============================================================
//  Data Aggregation — produces chart-ready structure
// ============================================================

function aggregateUsage(amountData, costData, year, month) {
  const amountTotal = amountData?.data?.biz_data?.total || [];
  const amountDays = amountData?.data?.biz_data?.days || [];
  const costBiz = costData?.data?.biz_data;
  const costTotal = Array.isArray(costBiz) ? costBiz[0]?.total || [] : costBiz?.total || [];
  const costDays = Array.isArray(costBiz) ? costBiz[0]?.days || [] : costBiz?.days || [];

  // Merge by model
  const modelMap = {};
  for (const item of amountTotal) {
    const m = modelMap[item.model] = modelMap[item.model] || { model: item.model, cacheHit: 0, cacheMiss: 0, output: 0, cost: 0, requests: 0 };
    for (const u of item.usage) {
      if (u.type === 'REQUEST') m.requests = parseInt(u.amount) || 0;
      else if (u.type === 'PROMPT_CACHE_HIT_TOKEN') m.cacheHit += parseInt(u.amount) || 0;
      else if (u.type === 'PROMPT_CACHE_MISS_TOKEN') m.cacheMiss += parseInt(u.amount) || 0;
      else if (u.type === 'RESPONSE_TOKEN') m.output += parseInt(u.amount) || 0;
    }
  }
  for (const item of costTotal) {
    const m = modelMap[item.model]; if (!m) continue;
    let sum = 0; for (const u of item.usage) sum += parseFloat(u.amount) || 0; m.cost = sum;
  }
  const models = Object.values(modelMap).filter(m => m.cacheHit + m.cacheMiss + m.output + m.requests > 0);

  // Merge daily: by model per day。日期 key 统一归一为 'MM-DD'，后续全部复用
  const dayModelMap = {};
  for (const day of amountDays) {
    const dk = String(day.date).slice(5);
    const dm = dayModelMap[dk] = dayModelMap[dk] || {};
    for (const item of day.data || []) {
      dm[item.model] = dm[item.model] || { cacheHit: 0, cacheMiss: 0, output: 0, requests: 0, cost: 0 };
      for (const u of item.usage) {
        if (u.type === 'REQUEST') dm[item.model].requests = parseInt(u.amount) || 0;
        else if (u.type === 'PROMPT_CACHE_HIT_TOKEN') dm[item.model].cacheHit += parseInt(u.amount) || 0;
        else if (u.type === 'PROMPT_CACHE_MISS_TOKEN') dm[item.model].cacheMiss += parseInt(u.amount) || 0;
        else if (u.type === 'RESPONSE_TOKEN') dm[item.model].output += parseInt(u.amount) || 0;
      }
    }
  }
  for (const day of costDays) {
    const dm = dayModelMap[String(day.date).slice(5)]; if (!dm) continue;
    for (const item of day.data || []) {
      if (!dm[item.model]) dm[item.model] = { cacheHit: 0, cacheMiss: 0, output: 0, requests: 0, cost: 0 };
      let sum = 0; for (const u of item.usage) sum += parseFloat(u.amount) || 0; dm[item.model].cost = sum;
    }
  }

  const totalTokens = models.reduce((s, m) => s + m.cacheHit + m.cacheMiss + m.output, 0);
  const totalCost = models.reduce((s, m) => s + m.cost, 0);
  const totalReqs = models.reduce((s, m) => s + m.requests, 0);

  // 稠密每日消费序列：整月逐日填满（缺日 = 0），当月只填到今天。
  // 柱子按数组下标等距排布，缺日会导致柱位错移，所以必须稠密。
  const now = tz8Now();
  const isCurrentMonth = now.getUTCFullYear() === year && now.getUTCMonth() + 1 === month;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDay = isCurrentMonth ? now.getUTCDate() : daysInMonth;
  const modelOrder = models.map(m => m.model);
  const days = [];
  for (let d = 1; d <= lastDay; d++) {
    const key = `${pad2(month)}-${pad2(d)}`;
    const dm = dayModelMap[key] || {};
    // parts 按 models 顺序排列：颜色与浮层行序都依赖它，不能按金额排序
    const parts = modelOrder
      .filter(m => dm[m] && dm[m].cost > 0)
      .map(m => ({ model: m, cost: dm[m].cost }));
    const dayTokens = Object.values(dm).reduce((s, m) => s + m.cacheHit + m.cacheMiss + m.output, 0);
    days.push({ date: key, day: d, cost: parts.reduce((s, p) => s + p.cost, 0), tokens: dayTokens, parts });
  }
  const todayDate = `${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
  const todayCost = isCurrentMonth ? (days[now.getUTCDate() - 1]?.cost ?? 0) : null;
  const todayTokens = isCurrentMonth ? (days[now.getUTCDate() - 1]?.tokens ?? 0) : null;

  return { models, days, totalTokens, totalCost, totalReqs, isCurrentMonth, todayDate, todayCost, todayTokens };
}

// ============================================================
//  Webview HTML Generator — Canvas Charts Dashboard
// ============================================================
//
// 数据不再拼进 HTML，只有面板创建和语言变化时才重建外壳，其余一律通过 postMessage 推送数据

// 月份下拉：以 UTC+8 的"当前月"为基准回溯 12 个月
function monthOptions() {
  const now = tz8Now();
  const out = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`);
  }
  return out;
}

function buildPanelHtml(i18n, langCode) {
  const monthOpts = monthOptions().map(v => `<option value="${v}">${v}</option>`).join('');
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
.month-select{padding:5px 10px;background:var(--vscode-input-background);color:var(--vscode-editor-foreground);border:1px solid var(--vscode-widget-border,rgba(128,128,128,.25));border-radius:4px;font-size:13px;cursor:pointer}
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
    <span class="toolbar-label">${i18n.monthLabel}</span>
    <select class="month-select" id="monthSelect">${monthOpts}</select>
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
  var rows = '<div class="tip-row tip-head"><span>' + D.year + '-' + b.date + '</span><span>¥' + fmtCost(b.cost) + '</span></div>';
  (b.parts || []).forEach(function(p) {
    rows += '<div class="tip-row"><span><i class="tip-dot" style="background:' + colorOf(p.model) + '"></i>' + esc(p.model) + '</span><span>¥' + fmtCost(p.cost) + '</span></div>';
  });
  return rows;
}

function drawDailyCostBar(canvas, days) {
  try {
    var ctx = getCtx(canvas.id); if (!ctx) return;
    var w = canvas.cw, h = canvas.ch;
    if (w < 40 || h < 40) return;   // 面板不可见时 getBoundingClientRect 全 0，会让 slot 变成 NaN

    var emptyText = !(D && D.hasUsage) ? i18n().noSessionToken : (D.error ? i18n().loadFailed : i18n().noDataThisMonth);
    if (!days || !days.length) { drawEmpty(ctx, w, h, emptyText); costBars = []; return; }

    var maxRaw = 0;
    days.forEach(function(d) { if (d.cost > maxRaw) maxRaw = d.cost; });
    if (maxRaw <= 0) { drawEmpty(ctx, w, h, emptyText); costBars = []; return; }

    var pad = { top: 12, right: 16, bottom: 26, left: 52 };
    var pw = w - pad.left - pad.right, ph = h - pad.top - pad.bottom;
    var n = days.length, slot = pw / n;
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
    days.forEach(function(d, i) {
      var x = pad.left + i * slot + (slot - barW) / 2;
      var sy = pad.top + ph;
      var parts = d.parts || [];
      parts.forEach(function(p) {
        var sh = ph * (p.cost / max);
        if (sh <= 0) return;
        sy -= sh;
        ctx.fillStyle = colorOf(p.model);
        ctx.fillRect(x, sy, barW, sh);
      });
      costBars.push({ x: pad.left + i * slot, w: slot, date: d.date, cost: d.cost, parts: parts });
    });

    // x 轴标签抽稀（每 34px 最多一个）
    var every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 34))));
    ctx.textAlign = 'center'; ctx.fillStyle = gridColor(); ctx.font = '10px sans-serif';
    days.forEach(function(d, i) {
      if (i % every === 0 || i === n - 1) {
        ctx.fillText(D.month + '/' + d.day, pad.left + i * slot + slot / 2, pad.top + ph + 14);
      }
    });

    // 按格命中（31 根细柱按柱命中太难）
    canvas.onmousemove = function(e) {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      var mx = (e.clientX - rect.left) * (canvas.cw / rect.width);
      if (mx < pad.left || mx > pad.left + pw) { hideChartTip(); return; }
      var idx = Math.floor((mx - pad.left) / slot);
      if (idx < 0 || idx >= costBars.length) { hideChartTip(); return; }
      showChartTip(e, tipHtml(costBars[idx]));
    };
    canvas.onmouseleave = hideChartTip;
  } catch (e2) { console.error('drawDailyCostBar:', e2); }
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

  // 卡B：今日消费（仅当月有意义）
  if (!d.hasUsage) {
    setText('todayValue', '—'); show('todaySuffix', false); setText('todaySub', L.noSessionToken);
  } else if (!d.isCurrentMonth) {
    setText('todayValue', '—'); show('todaySuffix', false); setText('todaySub', L.todayCurrentMonthOnly);
  } else {
    setText('todayValue', '¥' + fmtCost(d.todayCost)); show('todaySuffix', true);
    setText('todaySub', d.todayDate + ' · GMT+8');
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

// 月份下拉：选项列表变更时才重建，否则只同步选中值，保证回滚时下拉框能跟随回滚
function syncMonths() {
  var sel = document.getElementById('monthSelect'); if (!sel || !D || !D.monthOptions) return;
  var sig = D.monthOptions.join(',');
  if (sel.getAttribute('data-sig') !== sig) {
    sel.innerHTML = D.monthOptions.map(function(v) { return '<option value="' + v + '">' + v + '</option>'; }).join('');
    sel.setAttribute('data-sig', sig);
  }
  if (D.monthValue && sel.value !== D.monthValue) sel.value = D.monthValue;
}

// 画图：面板首次可见前 canvas 尺寸可能还是 0，用 rAF 重试一次
function drawChart(retried) {
  var c = document.getElementById('costChart'); if (!c) return;
  var r = c.getBoundingClientRect();
  if ((!r.width || !r.height) && !retried) { requestAnimationFrame(function() { drawChart(true); }); return; }
  drawDailyCostBar(c, D && D.hasUsage ? D.days : []);
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
  render(); syncMonths(); drawChart();
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

function onMonthChange() {
  var v = document.getElementById('monthSelect').value.split('-');
  setBusy(true); armBusySafety();
  toast(i18n().loading);
  post('changeMonth', { year: parseInt(v[0]), month: parseInt(v[1]) });
}

// ---- CSP-safe event binding (no inline onclick/onchange) ----
document.getElementById('refreshBtn').addEventListener('click', doRefresh);
document.getElementById('monthSelect').addEventListener('change', onMonthChange);
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
syncMonths();
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
      if (apiKeyCache) refresh(currentMonth, currentYear, 'late-key');
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
      warmApiKey().then((got) => { if (got) refresh(currentMonth, currentYear, 'key-ready'); }).catch(() => {});
    }
    return {
      apiKey: apiKeyCache !== undefined ? (apiKeyCache || configApiKey()) : configApiKey(),
      sessionToken: cfg.get('sessionToken', '') || '', cookie: cfg.get('cookie', '') || '', proxy: cfg.get('proxy', '') || '',
    };
  }

  // ---- Data ----
  let latestData = { balance: null, usage: null, error: null };
  let lastUpdatedAt = null;   // 最近一次成功取到数据的时刻（面板显示"数据更新时间"）
  let currentMonth, currentYear;
  let refreshInFlight = null;   // 进行中的刷新 Promise；null = 空闲
  let refreshQueued = null;     // 执行期间到达的刷新请求，仅保留最后一次，结束后补跑；用于串行化，避免并发写 latestData 与重复请求
  let refreshBusy = false;      // 刷新状态标志

  async function refreshAllData(month, year, source) {
    const now = new Date(); month = month || now.getMonth() + 1; year = year || now.getFullYear();
    currentMonth = month; currentYear = year;

    const cfg = await getConfig();
    latestData = { balance: null, usage: null, error: null };

    const results = await Promise.allSettled([
      cfg.apiKey ? fetchBalance(cfg.apiKey) : Promise.reject(new Error('no-api-key')),
      cfg.sessionToken && cfg.cookie ? fetchMonthData(cfg.sessionToken, cfg.cookie, cfg.proxy, month, year) : Promise.reject(new Error('no-session')),
    ]);

    const errors = [];
    if (results[0].status === 'fulfilled') latestData.balance = results[0].value;
    else if (results[0].reason.message !== 'no-api-key') errors.push(['Balance', results[0].reason.message]);
    if (results[1].status === 'fulfilled') latestData.usage = results[1].value;
    else if (results[1].reason.message !== 'no-session') errors.push(['Usage', results[1].reason.message]);
    // error 保留异常原文（面板 hover、日志排查用）；errorText 是展示给用户的本地化文案
    latestData.error = errors.length ? errors.map(([scope, m]) => scope + ': ' + m).join(' | ') : null;
    latestData.errorText = errors.length
      ? errors.map(([scope, m]) => tf('errEntry', scope === 'Balance' ? t().errScopeBalance : t().errScopeUsage, humanizeError(m))).join(' | ')
      : null;

    if (latestData.balance || latestData.usage) lastUpdatedAt = Date.now();

    updateStatusBar();
  }

  // 刷新入口：串行化执行，同一时刻至多一次；执行期间到达的请求合并为一次尾随刷新
  function refresh(month, year, source) {
    if (refreshInFlight) { refreshQueued = { month, year, source }; return refreshInFlight; }
    refreshBusy = true;
    pushData(); // 推送 busy=true，供按钮反馈
    refreshInFlight = (async () => {
      try { await refreshAllData(month, year, source); }
      // 兜底：刷新流程本身抛异常（非接口错误）时同样给出两份文案，避免 errorText 残留上一次的
      catch (e) { latestData.error = (e && e.message) || String(e); latestData.errorText = humanizeError(latestData.error); }
      finally {
        refreshBusy = false; refreshInFlight = null;
        const q = refreshQueued; refreshQueued = null;
        pushData(); // 推送数据（或错误）
        if (q) refresh(q.month, q.year, q.source);
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
    const { balance, usage, error, errorText } = latestData;
    if (error) { statusBarItem.text = '$(error) DeepSeek Usage'; statusBarItem.tooltip = errorText ? `${errorText}\n(${error})` : error; statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground'); return; }
    const bal = balance?.balance_infos?.[0]; const balTotal = bal ? parseFloat(bal.total_balance).toFixed(2) : null;
    const cost = usage ? usage.totalCost.toFixed(2) : null;
    // 选了往月时 aggregateUsage 给 todayCost/todayTokens=null（"今日"对往月无意义），与面板一致显示 —
    const today = usage && usage.todayCost != null ? usage.todayCost.toFixed(2) : null;
    const todayTokens = usage && usage.todayTokens != null ? usage.todayTokens : null;

    // 未配置任何凭证时保留引导，避免状态栏显示一长串 —
    if (!balTotal && !usage) {
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
    const { balance, usage, error, errorText } = latestData;
    const balInfo = (balance && Array.isArray(balance.balance_infos) && balance.balance_infos.length) ? balance.balance_infos[0] : null;
    const bal = balInfo ? {
      toppedUp: parseFloat(balInfo.topped_up_balance) || 0,
      granted: parseFloat(balInfo.granted_balance) || 0,
      // is_available 是"余额是否足以继续调用 API"的标志，为 false 时数字仍然有效，只降级成一行提示
      insufficient: balance.is_available === false,
    } : null;
    return {
      i18n: t(), month: currentMonth, year: currentYear, monthValue: `${currentYear}-${pad2(currentMonth)}`,
      monthOptions: monthOptions(),
      busy: refreshBusy,
      keyDegraded,
      error: error || null,
      errorText: errorText || null,
      updatedAt: lastUpdatedAt,
      hasBalance: !!balInfo, bal,
      hasUsage: !!usage,
      models: usage ? usage.models : [], days: usage ? usage.days : [],
      totalCost: usage ? usage.totalCost : 0, totalTokens: usage ? usage.totalTokens : 0, totalReqs: usage ? usage.totalReqs : 0,
      isCurrentMonth: usage ? usage.isCurrentMonth : false, todayDate: usage ? usage.todayDate : '', todayCost: usage ? usage.todayCost : null,
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
    currentPanel.webview.html = buildPanelHtml(t(), langKey());
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
    currentPanel.webview.html = buildPanelHtml(t(), langKey());

    currentPanel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === 'ready') {
          panelReady = true;
          pushData();
          // 首屏可能还没有数据（激活时的首次刷新仍在等待返回），这里补推一次数据
          if (!refreshInFlight && !latestData.balance && !latestData.usage) refresh(currentMonth, currentYear, 'ready');
        } else if (msg.type === 'refresh') {
          await refresh(currentMonth, currentYear, 'panel');
        } else if (msg.type === 'changeMonth') {
          // 失败时需要回滚月份，否则下拉框、页面数据与内部状态将不一致导致错误
          const prev = { month: currentMonth, year: currentYear, data: latestData };
          await refresh(msg.month, msg.year, 'month');
          // 未配置凭证（无 error）时照常渲染，面板提示需配置凭证；
          // 只有凭证已配置情况下请求拉取失败（如 session 过期）时才回滚月份 + 弹出错误
          if (!latestData.usage && !latestData.balance && latestData.error) {
            // 回滚会把 latestData 换成上一次的数据，失败原因须先取出
            const failedReason = latestData.errorText || latestData.error;
            currentMonth = prev.month; currentYear = prev.year; latestData = prev.data;
            updateStatusBar();
            pushData(); // 同时回滚下拉框与面板数据至上一个月份
            vscode.window.showErrorMessage(
              tf('loadMonthFailed', `${msg.year}-${pad2(msg.month)}`, failedReason || tf('checkSessionToken'))
            );
          }
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
    refreshTimer = setInterval(() => refresh(currentMonth, currentYear, 'auto'), minutes * 60 * 1000);
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
      refresh(currentMonth, currentYear, 'setApiKey');
      return;
    }
  }

  // ---- Commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek-usage-monitor.showUsage', () => openUsagePanel()),
    vscode.commands.registerCommand('deepseek-usage-monitor.refresh', () => refresh(currentMonth, currentYear, 'command')),
    vscode.commands.registerCommand('deepseek-usage-monitor.setApiKey', () => promptApiKeyFlow()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('deepseek-usage-monitor')) return;
      if (e.affectsConfiguration('deepseek-usage-monitor.refreshInterval')) startAutoRefresh();
      if (e.affectsConfiguration('deepseek-usage-monitor.language') && currentPanel) rebuildShell();
      refresh(currentMonth, currentYear, 'config');
    }),
    statusBarItem
  );

  // Init —— 首刷不阻塞 activate()：网络慢时会让扩展激活挂起数秒（请求超时上限 15s），状态栏先显示加载态即可
  refresh(undefined, undefined, 'init');
  // 自动刷新必须带上当前选中的月份，否则会把用户选的月份重置回当月
  startAutoRefresh();
  context.subscriptions.push({ dispose: stopAutoRefresh });
  console.log('[DeepSeek Usage Monitor] Activated');
}

function deactivate() { console.log('[DeepSeek Usage Monitor] Deactivated'); }
module.exports = { activate, deactivate };
