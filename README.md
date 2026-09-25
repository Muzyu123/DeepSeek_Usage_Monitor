# DeepSeek Usage Monitor

在 VSCode 里实时查看 DeepSeek API 的余额与用量：状态栏可自定义显示信息，详情面板复刻官网用量页风格，用量一目了然。

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/Muzyu.deepseek-usage-monitor?label=marketplace&color=blue)](https://marketplace.visualstudio.com/items?itemName=Muzyu.deepseek-usage-monitor)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/Muzyu.deepseek-usage-monitor)](https://marketplace.visualstudio.com/items?itemName=Muzyu.deepseek-usage-monitor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**简体中文** ｜ [English](README.en.md)

> 本项目重构修改自 linnin233 的 MIT 项目：https://github.com/linnin233/deepseek-usage-vscode，插件名称为“Deepseek Usage & Cost”，可以支持一下原作者！
> 本项目与原作者及 DeepSeek 官方均无隶属关系

## 功能

- **可自定义状态栏信息显示**：底栏右侧常驻显示本日消费 / 本月消费 / 账户余额 / 本日消耗token，显示项目可随意配置
- **仿 Official 风格面板**：充值余额卡片、累计消费、月消费金额 / API 请求次数 / Tokens 统计、每日消费柱状图
- **支持中英文切换**：默认简体中文
- **自动刷新**：可自由设置刷新频率，默认1分钟刷新一次
- **支持 HTTP 代理**：继承自原项目

## 配置

在设置中搜索 `deepseek-usage-monitor`，或编辑 `settings.json`：

| 配置项                                     | 说明                                                                                                                               | 必填         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `API Key`                                    | 点击详情面板中的“设置 API Key”按钮进行设置                                                                                       | 是           |
| `deepseek-usage-monitor.sessionToken`    | Session Token (`Bearer ...`)，用于查询用量                                                                                       | 是           |
| `deepseek-usage-monitor.cookie`          | 浏览器 Cookie，与 Session Token 配合使用                                                                                           | 是           |
| `deepseek-usage-monitor.proxy`           | HTTP 代理地址                                                                                                                      | 否           |
| `deepseek-usage-monitor.language`        | 显示语言：`en` / `zh-cn`                                                                                                       | 否(默认简中) |
| `deepseek-usage-monitor.statusBar.items` | 状态栏显示项（数组，顺序即显示顺序）：`todayCost` / `monthCost` / `balance` / `todayTokens`，默认 `[todayCost, balance]` | 否           |
| `deepseek-usage-monitor.refreshInterval` | 自动刷新间隔（单位：分钟），默认`1`；可填小数（`0.5` = 30 秒），设为 `0` 则关闭自动刷新                                      | 否           |

### 如何获取 Session Token 和 Cookie（2026.9实测）

1. 浏览器登录进入 **Usage** 页面 [platform.deepseek.com/usage](https://platform.deepseek.com/usage)
2. 按 `F12` → **Network(网络)/右键菜单'检查'** → 找到 `cost?start=xxx` 请求
3. 复制 Authorization 请求头的全部内容（Bearer xxxxxx），填入设置项中的Session Token即可
4. 获取方式同上，一般在 Authorization 请求头的下面就是 Cookie 请求头，复制其全部内容填入设置项中的Cookie即可

> Session Token / Cookie 会过期，数据不刷新时请重新获取。

## 命令

| 命令                                       | 说明                               |
| ------------------------------------------ | ---------------------------------- |
| `DeepSeek Usage Monitor: Open Dashboard` | 打开用量面板                       |
| `DeepSeek Usage Monitor: Refresh`        | 手动刷新                           |
| `DeepSeek Usage Monitor: Set API Key`    | 设置 API Key（写入 SecretStorage） |

## 数据与隐私

- 所有请求只发往 DeepSeek 官方域名（`api.deepseek.com`、`platform.deepseek.com`），不经过任何第三方服务器
- API Key 保存在 VSCode **SecretStorage**（`deepseek-usage-monitor.apiKey`）中，若密码管理器异常不可用则降级到内存缓存模式，API Key仅当次会话有效，重启后需重新配置
- Session Token 与 Cookie 因可能需要不定期更新，保存在 VSCode 设置中（明文 `settings.json`），**请务必注意数据安全**
- 若配置了 `proxy`，请求会经该代理转发

## 已知限制

- 用量接口依赖平台内部 API（`platform.deepseek.com/api/v0/usage/*`），DeepSeek 官方改动网页接口时可能失效
- Session Token / Cookie 过期需手动更新，暂未包含自动续期功能

## 致谢

- 原始项目：[linnin233 / ds-usage-cost](https://github.com/linnin233/deepseek-usage-vscode)（MIT），本项目在其基础上修改重构，力求实现更好的信息展示、更稳定的表现和更丰富使用的功能。

## License

[MIT](LICENSE) — 原始部分版权归属 linnin233，修改与重写部分版权归属 Muzyu（双版权声明，详见 LICENSE）。
