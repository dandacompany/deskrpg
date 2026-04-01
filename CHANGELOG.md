# Changelog

All notable changes to this project will be documented in this file.

This project follows a Keep a Changelog style workflow.
GitHub Releases will be written later at actual release time.

## [Unreleased]

### Added
- Channel owners can now delete meeting minutes from the minutes detail view.
- The meeting room sidebar can now be resized with a drag handle.
- The meeting start form now supports a collapsed settings panel.
- The meeting topic field now uses a multi-line textarea.

### Changed
- Meeting room metadata now reflects the active channel name.
- Meeting room start controls were simplified to show only the essential inputs by default.
- README screenshots and animated GIFs were refreshed and normalized to the same aspect ratio.

### Fixed
- Fixed duplicated NPC meeting messages during streamed discussions.
- Fixed streamed NPC responses disappearing when a turn completed.
- Fixed `SPEAK:` prefixes leaking into meeting room streaming and final messages.
- Fixed meeting room poll status rendering `[object Object]` for raised hands.
- Fixed meeting minutes parsing when SQLite returned JSON fields as strings.
- Fixed the active meeting chat panel so the input stays visible while messages scroll.

### Known Issues
- Some README GIF assets are larger than ideal and may need further optimization.

## Release Process

1. Keep new work under `Unreleased` while development is in progress.
2. At release time, move `Unreleased` items into a versioned section such as `## [0.1.1] - 2026-04-01`.
3. Create the git tag and publish the matching GitHub Release from that versioned section.
4. Start a fresh `Unreleased` section for the next cycle.
