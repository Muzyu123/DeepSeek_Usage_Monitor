# Changelog

[简体中文](CHANGELOG.md) ｜ **English**

## 3.0.1 — 2026-10-25

### Fixed

- **Inconsistent bar chart heights**: the Cost chart is now 220px high instead of 260px, so all three charts are the same height
- **Importing a default-palette configuration could not override the settings**: an empty color object is now accepted as a valid value (all three charts return to the official palette)
- **No overflow protection for `refreshInterval`**: the auto-refresh interval is now capped at 1 day
- **No character limit on `statusBar.label`**: the label is now limited to 64 characters
- **UTF-8 BOM was not handled when importing a configuration**: the BOM is now stripped (explicit `\uFEFF` match), so files saved with a BOM import correctly
- **Numeric-string timestamps were not recognized**: added a parsing branch for pure-digit strings (Unix seconds or milliseconds)

## 3.0.0-beta.1 — 2026-10-17

### Added

- **API requests & Tokens bar charts**: similar to the "Cost" chart, but each chart has its own color settings; the three charts (Cost / API requests / Tokens) can each be shown or hidden, and their order is configurable
- **Time zone auto-detection**: the extension automatically detects your machine's time zone by default, and any time zone can be set manually
- **Cycling the cost-statistics card**: clicking the button in the card's top-right corner cycles the card content between "Today's cost → This month's cost → Total cost"
- **Customizable dashboard font size**: new `dashboard.fontScale` setting (`0.8`–`1.4`); dashboard text, card values and chart axis labels scale together
- **Tokens breakdown tooltip**: hovering a Tokens bar shows, for each model, "Input (cache hit) / Input (cache miss) / Output / Cache hit rate"

### Changed

- **The extension host now always runs locally**: when connected to a remote host, the extension host moves from the remote machine to your local machine, so private data is stored locally and requests no longer go through the remote server
- **File picker in remote windows**: in a remote window, picking a background image, importing a configuration or exporting a configuration now opens the OS's native file dialog on the local machine instead of VSCode's remote file picker
- **Clearer messages when the dashboard has no data**: the previous single "Configure Session Token & Cookie" is now split into four states — fetching data / credentials not configured / credentials configured but the request failed / no data in this period — which pinpoints why no data is shown
- **Faster color changes**: changing only the bar chart colors re-renders the chart without fetching the data again
- **Amounts show the currency code only**: amounts now read `10.00 USD` (value + code) instead of using symbols such as `$` / `¥`
- **Faster startup**: `activationEvents` changed from `onStartupFinished` to `*`, so the status bar no longer waits for the remote connection to complete and appears together with the window

### Fixed

- **Currency was hard-coded to CNY**: accounts holding several currencies are now supported — the balance / cost cards list every currency, and the cost chart lets you switch between them
- **Configuration migration omission**: card opacity can now be exported and imported with the configuration file

## 2.2.0 — 2026-10-15

### Changed

- **Granted balance gets its own card**: instead of being shown under the "Topped-up balance" card as in the previous version, the granted balance now has a dedicated card
- **Marketplace category change**: the Open VSX "Categories" tag was changed from "Other" to "AI"

## 2.1.0 — 2026-10-03

### Added

- **Quickly close the dashboard**: while the dashboard is in the foreground, clicking the status bar item closes it. The switch lives in Settings and is off by default
- **Customizable status bar label**: the default "DeepSeek Usage" text can now be replaced with any text of up to 64 characters

### Changed

- The bar chart's axis labels now use the foreground color, which makes them easier to read
- The x-axis tick labels now behave like the official usage page: at most four ticks

## 2.0.0 — 2026-09-30

### Added

- **Customizable dashboard background**: image / solid color / gradient; both the dimming over the background image (`dashboard.backgroundDim`) and the opacity of the card background (`dashboard.cardOpacity`) are adjustable, so the text stays readable
- **Customizable chart colors**: three modes — official palette / per-model colors / single base color with automatic shades — with a color picker built into the dashboard (RGB / HSL / HEX input and an eyedropper)
- **Configuration migration**: export settings and dashboard state to JSON and read them back at any time; Session Token, Cookie and API Key are not included
- **A "⚙ Settings" menu in the dashboard** that hosts: set background image (change / clear), set API Key, migrate configuration (export / import), open Settings

### Changed

- The "Set Background" and "Set API Key" buttons in the dashboard header moved into the "⚙ Settings" menu; the header now has a single entry point
- Secondary text in the dashboard (time range, card titles, "Updated" timestamp) is no longer grey but follows the theme's foreground color
- Simplified the main card content by removing the GMT+8 note

## 1.2.2 — 2026-09-29

### Changed

- Published on the Visual Studio Marketplace. To avoid a display-name clash, the store name was changed to DeepSeek Usage Monitor & Dashboard.

## 1.2.1 — 2026-09-27

### Fixed

- Fixed some text errors in README.md.

## 1.2.0 — 2026-09-27

### Changed

- Added a time range selector to the dashboard (Today / Yesterday / Last 7 days / Last 30 days / This month / Last month).

## 1.1.5 — 2026-09-27

### Fixed

- **Day-boundary error that shifted everything by 8 hours**: the platform's monthly endpoint buckets by UTC, so usage between 00:00 and 08:00 (GMT+8) was counted toward the previous day. The monthly endpoint has been dropped in favour of the range endpoint.

### Changed

- Usage data now comes from the same range endpoint the official usage page uses (`/api/v0/usage/by_api_key/{amount,cost}?start&end&tz=28800`), aggregated into day buckets by the extension itself.
- Removed the "Top up" button.
- Added the "Updated" timestamp display.

## 1.1.0 — 2026-09-25

First public release.
