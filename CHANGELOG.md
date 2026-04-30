# Changelog

All notable changes to this project will be documented in this file.

## [3.0.0] - 2026-04-30

### Added
- Floating action button (FAB) fixed at bottom-right corner with badge count
- Side panel with collapsible prompt cards — no longer injects into the ChatGPT DOM
- SVG icons throughout (no emoji) for a clean, professional look
- Copy button occupies full card width for easy clicking
- Visual feedback on copy (icon switches to checkmark, toast notification)
- Dark mode support

### Changed
- Completely reworked UI from DOM-injection to FAB + panel model
- Panel auto-hides when no prompts are found
- Badge count updates in real time as new prompts are extracted

### Fixed
- Removes `<|has_watermark|>` and similar internal control tokens from prompt text
- Prevents duplicate prompt display across polling cycles

---

## [2.1.0] - 2026-04-30

### Added
- Multi-strategy prompt extraction (A: code blocks, B: tool messages, D/E/F: metadata)
- Status indicator in bottom-right corner showing current extraction state

### Changed
- Switched from fetch-interception to direct API polling for reliability
- Uses `@grant none` to run in page context and access session token

---

## [2.0.0] - 2026-04-30

### Changed
- Moved from SSE stream interception to direct `/backend-api/conversation/{id}` polling
- Extraction logic targets assistant code messages and tool multimodal_text messages

---

## [1.0.0] - 2026-04-30

### Added
- Initial release: fetch interception + SSE parsing to extract `revised_prompt`
