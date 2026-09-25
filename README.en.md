# DeepSeek Usage Monitor

Keep an eye on your DeepSeek API balance and usage right inside VSCode: a customizable status bar readout, plus a dashboard that mirrors the look of the official usage page.

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/Muzyu.deepseek-usage-monitor?label=marketplace&color=blue)](https://marketplace.visualstudio.com/items?itemName=Muzyu.deepseek-usage-monitor)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/Muzyu.deepseek-usage-monitor)](https://marketplace.visualstudio.com/items?itemName=Muzyu.deepseek-usage-monitor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[简体中文](README.md) ｜ **English**

> This project is a refactor of the MIT-licensed project by linnin233: https://github.com/linnin233/deepseek-usage-vscode — the extension there is called “Deepseek Usage & Cost”, go give the original author some support!
> This project is not affiliated with the original author or with DeepSeek.

## Features

- **Customizable status bar readout**: today's cost / this month's cost / account balance / tokens used today, shown on the right side of the status bar; the items and their order are fully configurable
- **Dashboard in the style of the official page**: top-up balance card, cumulative usage, monthly cost / API requests / tokens stats, and a daily cost bar chart
- **Chinese and English UI**: Simplified Chinese by default
- **Auto refresh**: refresh interval is configurable, once a minute by default
- **HTTP proxy support**: inherited from the original project

## Configuration

Search for `deepseek-usage-monitor` in Settings, or edit `settings.json`:

| Setting                                     | Description                                                                                                                     | Required          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `API Key`                                   | Click the “Set API Key” button in the dashboard to configure it                                                                   | Yes               |
| `deepseek-usage-monitor.sessionToken`       | Session Token (`Bearer ...`), used to query usage                                                                                 | Yes               |
| `deepseek-usage-monitor.cookie`             | Browser Cookie, used together with the Session Token                                                                              | Yes               |
| `deepseek-usage-monitor.proxy`              | HTTP proxy URL                                                                                                                    | No                |
| `deepseek-usage-monitor.language`           | Display language: `en` / `zh-cn`                                                                                                  | No (default: zh-cn) |
| `deepseek-usage-monitor.statusBar.items`    | Which items the status bar shows (array; order = display order): `todayCost` / `monthCost` / `balance` / `todayTokens`, default `[todayCost, balance]` | No |
| `deepseek-usage-monitor.refreshInterval`    | Auto-refresh interval (in minutes), default `1`; decimals allowed (`0.5` = 30 seconds); set to `0` to turn auto refresh off        | No                |

### How to get the Session Token and Cookie (verified September 2026)

1. Sign in to the **Usage** page in your browser: [platform.deepseek.com/usage](https://platform.deepseek.com/usage)
2. Press `F12` → **Network** (or right-click → Inspect) → find the `cost?start=xxx` request
3. Copy the whole `Authorization` request header (Bearer xxxxxx) and paste it into the Session Token setting
4. Same steps for the Cookie: it usually sits right below the `Authorization` header — copy the whole `Cookie` request header into the Cookie setting

> Session Tokens and Cookies expire. If the data stops refreshing, fetch them again.

## Commands

| Command                                    | Description                          |
| ------------------------------------------ | ------------------------------------ |
| `DeepSeek Usage Monitor: Open Dashboard`   | Open the usage dashboard             |
| `DeepSeek Usage Monitor: Refresh`          | Refresh manually                     |
| `DeepSeek Usage Monitor: Set API Key`      | Set the API Key (stored in SecretStorage) |

## Data and privacy

- All requests go to DeepSeek's official domains only (`api.deepseek.com`, `platform.deepseek.com`); nothing is routed through third-party servers
- The API Key is stored in VSCode's **SecretStorage** (`deepseek-usage-monitor.apiKey`). If the system keyring is unavailable, VSCode silently falls back to an in-memory cache, in which case the API Key is valid for the current session only and has to be set again after a restart
- The Session Token and Cookie are kept in VSCode settings (plain text in `settings.json`) because they may need to be updated from time to time — **mind the security implications**
- If `proxy` is configured, requests are forwarded through that proxy

## Known limitations

- The usage endpoints rely on the platform's internal API (`platform.deepseek.com/api/v0/usage/*`); they may break whenever DeepSeek changes the web app
- Session Tokens and Cookies expire and must be updated manually; automatic renewal is not implemented yet

## Credits

- Original project: [linnin233 / ds-usage-cost](https://github.com/linnin233/deepseek-usage-vscode) (MIT). This project refactors and extends it, aiming for better information display, a more stable experience and a richer feature set.

## License

[MIT](LICENSE) — copyright for the original parts belongs to linnin233; the rewritten and modified parts are copyright Muzyu (dual copyright notice, see LICENSE for details).
