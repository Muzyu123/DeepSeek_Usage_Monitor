# Changelog

[简体中文](CHANGELOG.md) ｜ **English**

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
