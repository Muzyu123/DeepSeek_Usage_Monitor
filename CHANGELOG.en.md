# Changelog

[简体中文](CHANGELOG.md) ｜ **English**

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

- **Day-boundary error that shifted everything by 8 hours**: the platform's monthly endpoint buckets by UTC, so usage between 00:00 and 08:00 (GMT+8) was counted towards the previous day. The monthly endpoint has been dropped in favour of the range endpoint.

### Changed

- Usage data now comes from the same range endpoint the official usage page uses (`/api/v0/usage/by_api_key/{amount,cost}?start&end&tz=28800`), aggregated into day buckets by the extension itself.
- Removed the "Top up" button.
- Added the "Updated" timestamp display.

## 1.1.0 — 2026-09-25

First public release.
