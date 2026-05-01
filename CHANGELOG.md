# Changelog

All notable changes to this project will be documented in this file.

## [5.0.0] - 2026-05-01

### Added
- **ZIP Batch Download**: Batch downloading (all, selected, or per-round) now packages images into a single `.zip` archive via JSZip, avoiding browser spam.
- **Hover Preview**: Hovering over a thumbnail now smoothly reveals a large, uncropped high-res preview image floating to the left.
- **Round Download**: Added a dedicated "下载本轮" (Download Round) button to easily grab all images generated in a specific conversation turn.
- **Auto Token Refresh**: Automatically refreshes the session token via `/api/auth/session` if it expires, fixing the `401 API Error` on long sessions.

### Changed
- **Unified UI Theme**: Checkboxes, download buttons, and all UI elements have been standardized to the "ChatGPT Green" (`#10a37f`) color scheme.
- **Clean Numbering**: Replaced internal data source tags (Caption/DALL-E) with simple, sequential numbers (`#1`, `#2`) for cleaner readability.
- **Gallery Removal**: Removed the expanded card image gallery to reduce UI clutter, fully replacing it with the new hover preview system.
- **Throttling**: API requests are now throttled to prevent spamming the backend and gracefully handle `429 Too Many Requests` limits.

### Fixed
- Fixed custom checkbox rendering to guarantee consistent green styling across Safari and Chrome, bypassing native browser styling overrides.
- Fixed hover image cropping issue by ensuring preview container dynamically scales with the image's original aspect ratio.
- Fixed the issue where switching back to old conversations triggered redundant data fetches.

---

## [4.0.0] - 2026-04-30

### Added
- **Thumbnail previews**: each prompt card now displays a thumbnail of its generated image
- **Multi-select & batch download**: checkbox on every card, select all / deselect all, download selected or all images
- **Round-based grouping**: prompts are visually separated into chat rounds with dividers (第 1 轮, 第 2 轮…)
- **Image gallery**: expanded card shows full-size images, click to open in new tab
- **Lazy image resolution**: file IDs from API (`asset_pointer`) are matched to DOM images on each render, with 3-second delayed retry
- Footer bar with "下载选中" and "全部下载" buttons

### Changed
- Image extraction now handles ChatGPT's `asset_pointer: "file-service://file-xxxx"` format
- DOM image selectors broadened to cover all generated images within the chat area
- Round numbering filters out system and context messages, renumbers after filtering
- Download button counts selected items (not just images)

### Fixed
- Round numbering skipping round 1 (was caused by system/user_editable_context nodes)
- Download button always showing (0) when images hadn't loaded yet
- Images not matching due to narrow DOM selectors

---

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
