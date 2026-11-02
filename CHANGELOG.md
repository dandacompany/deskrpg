# Changelog

All notable changes to this project will be documented in this file.

This project follows a Keep a Changelog style workflow.
GitHub Releases will be written later at actual release time.

## [Unreleased]

### Added

- Brazilian Portuguese (`pt`) locale, including the office renderer strings, room and environment labels,
  NPC smalltalk lines and the meeting protocol response-language contract.

## [2026.1019.1] - 2026-10-19

### Added

- Deliver original files to Hermes in direct messages, rooms, and meetings, with per-profile access and execution preparation.
- Show upload and preparation status, retry or cancel failed requests, download originals, and retain file references in meeting archives.

### Fixed

- Preserve original file access when text extraction is unavailable.
- Use Hermes file identifiers in tool manifests so preparing an attachment again succeeds.

### Changed

- Install DeskRPG Hermes plugin 0.32.0 for original conversation file support.

## [2026.921.2] - 2026-09-21

### Fixed

- Read kanban times as the epoch seconds the plugin actually sends. The UI parsed them as date strings, so against a real gateway the task drawer showed run history dated 1970, the elapsed badge on running cards never appeared, and sorting by created or started time silently did nothing. The test fake emitted ISO strings, which is why tests stayed green; it now emits epoch seconds like the plugin.
- Retry a staff report whose call was rejected once that staff member's state changes, instead of never calling again. Rejections are logged to the console for diagnosis.
- Show a rejected staff call to the user and roll back the optimistic ownership, and close two paths where a call ended silently with nothing happening.
- Settle the return from a meeting on the server when no browser is driving the walk, so staff no longer stay in their meeting seats.
- Keep every connected socket listening to the office room, so automation notices arrive without opening the room first.
- Restart the gateway after a plugin-only update, and decide whether a restart is needed from the host's reported changes.

### Added

- View the same kanban board as a list: group by subproject (tenant), assignee, status or priority; filter by subproject, assignee or warnings; sort; per-group status progress bars; and expand a card's subtasks on demand. Filters apply to the board view too, so both views always show the same cards. The view is remembered per channel in the browser.
- Have the assigned staff member walk over and report when a card reaches review, blocked or done, or when a cron run fails. The report stays in the office room when nobody is online.
- Show the connected gateway's installed plugin version next to the pinned version, and update the plugin from the screen.
- Record a structured outcome when a meeting ends (decisions, follow-up tasks with assignee and ordering, and whether the work should be tracked as a project) along with a summary status. A failed summary is now recorded as failed instead of being stored as an empty success, and can be retried from the stored transcript by the meeting host or channel owner.

### Changed

- Let a channel hold more than one kanban board. The board link table moves to a surrogate key (migration 0017 keeps existing rows and event cursors), the automation poller polls each board and saves cursors per board, and exactly one board per channel carries the gateway-wide cron and artifact events. Kanban REST routes accept `?board=`; omitting it keeps the previous meaning. A project picker appears in the board header when a channel has two or more boards. Creating a second board from the UI is not available yet.
- Add project and subproject metadata tables and REST routes (status, lead, target date, colour, icon, originating meeting). Names and progress are not copied; they are read from the Hermes board.
- Add approval records (migration 0018) and the batch entry point that creates cards as blocked until approved. Nothing in the UI calls it yet, and it requires a plugin newer than 0.10.2.
- Add REST plumbing for bulk link and run-history queries behind a plugin capability gate; it stays dormant until the plugin provides those routes.

## [2026.921.1] - 2026-09-21

### Added

- Run DeskRPG natively on Windows. The connection wizard finds or installs a local Hermes, registers the gateway as a Scheduled Task, and reaches Linux hosts over SSH without a multiplexing socket (Windows OpenSSH has none). POSIX behaviour is unchanged.
- Show who is speaking: circular avatars beside other people's bubbles (omitted when the same speaker continues), in the direct-message header, stacked in room headers with a `+N` overflow, and in meeting speech bubbles.
- List direct messages with staff in the conversation list, with the last line of each. Opening one only reads; the staff member is called when you send.
- Promote a single-line link to an OpenGraph preview card. The server-side fetcher refuses private, loopback, link-local, CGNAT and IPv4-in-IPv6 addresses, re-checks every redirect hop and the address the socket actually connects to, and proxies only raster images.
- Add a download icon to file links and images in chat, including inline base64 images, which used to render as an empty box.
- Inject a report-format rule ahead of staff conversations in direct messages, the office room and meetings.
- List a card's attachments alongside its artifacts in the task drawer.

### Changed

- Pin the Hermes plugin to 0.10.2: the model list now contains only what the signed-in account can actually use, in the order Hermes intends (a Codex profile signed in with a ChatGPT account no longer offers public API models that fail at chat time).
- Paint the `@` mention dropdown with brand tokens; white text on the cream surface made the selected entry unreadable.

### Fixed

- Open the task drawer when a kanban card is clicked. Pointer capture added for dragging retargeted the click away from the detail button. The card no longer captures the pointer; a press is tracked on the window instead, and the click that ends a drag is swallowed so dropping outside the board does not close the modal.
- Keep staff out of the executive seat. The chair behind an `executive_desk` is no longer an assignable desk seat, and staff already sitting there are moved on the next server start.
- Keep the request-address warning in the hire wizard out of the button row, where it squeezed the Save and Done buttons until their labels wrapped one character per line.
- Keep the host bootstrap ASCII-only. It is the one host script passed as a `python3 -c` argument, so a non-ASCII comment stopped it from starting on hosts with a C/POSIX locale.
- Round the install elapsed-time counter instead of flooring it; it could lag a second behind.

## [2026.920.7] - 2026-09-20

### Added

- Explain what is missing when the gateway or plugin is not ready: kanban, cron and artifacts open a four-step checklist at the moment of failure, with the install command or a link to the connection screen. Plain errors (timeouts, 500s) show their cause instead of pretending setup is incomplete.

### Fixed

- Keep the "AI Coworking Space" subtitle on its own line under the DeskRPG title on the landing page — at some widths only "AI" stayed on the title line.
- Stop the cron delivery-target preload and the task drawer's artifact section from swallowing gateway failures as "nothing here".
- Refresh the README animations and home screenshot to the current UI; the capture pipeline follows seat assignment again.

## [2026.920.6] - 2026-09-20

### Fixed

- Tell the hire wizard when a profile still carries a model endpoint from the default profile, and clear it on confirmation — otherwise a new provider kept sending requests to the old address.

## [2026.920.5] - 2026-09-20

### Fixed

- Keep the password change form at a readable width — the shared page frame stretched its inputs across the full 1200px column.
- Draw the sign-in clouds whole: the render framing cropped them top and bottom, and their lobes no longer read as separate spheres.

## [2026.920.4] - 2026-09-20

### Added

- Recover a password without email: a system administrator resets one from the group member list, `deskrpg reset-password <loginId>` unlocks a locked-out administrator from the host, and the owner changes it from the account screen. A temporary password appears once in the response and is never stored in the database or logs.

### Changed

- Sign-in screen speaks the same brand as the app: "AI Coworking Space" instead of "for Hermes", the 3D miniature mark beside the wordmark, a smaller sun and slow-drifting clouds rendered from the same three.js pipeline.

## [2026.920.3] - 2026-09-20

### Fixed

- Install the published plugin (0.10.0) from the connection wizard — the pinned commit was still 0.6.0, so a Hermes installed from the wizard could not show in-app provider login or per-tool provider settings.

## [2026.920.2] - 2026-09-20

### Added

- Connect a Hermes host locally or over SSH from the wizard: administrators get both by default, register SSH hosts with a DeskRPG-only key or with the server's own `~/.ssh/config` and agent.
- Install Hermes on a host without python3 — the setup launcher fetches a user-local Python with uv, and names the sudo-only packages (git, C++ compiler, curl) with the exact command when it cannot continue.
- Show gateway state on the discovery card: running, stopped (connecting starts it) or blocked by separately running profile gateways.

### Changed

- Host discovery lists one gateway and its profiles instead of one candidate per profile.
- Screens carry less instruction text: blocked reasons sit behind a `?` button, the hire wizard moves with Back/Next, office join codes and group invites open in a dialog, and share/diagnostics moved into header buttons.
- Korean UI says "오피스" everywhere (was a mix of 채널 and 사무실).
- New 3D miniature logo rendered from the same three.js model as the sidebar headquarters, with a simplified favicon that reads at 16px.
- Web screens use the Dante Labs brand v2 tokens (cream surfaces, navy text, 8px radius cap, navy-tinted shadows); the office green stays as the single product accent.
- Release note: `2026.920.1` was tagged but never published — its release job failed before npm/GHCR upload.
- One page frame for every workspace screen — the same padding and max width instead of per-page values.

## [2026.9.19] - 2026-09-15

### Added

- Enter meetings by walking into the meeting space in each office map; legacy maps receive an attached meeting area.
- Keep meetings on the original map and characters, with wall fading, speaker camera motion and manual camera rotation.
- Improve Hermes gateway setup diagnostics and first-account guidance.

### Fixed

- Keep board and seat interactions distinct while walking into meetings.
- Return channel owners from gateway setup to the kanban board.
- Avoid a synchronous effect update when checking clipboard availability.

## [2026.9.17] - 2026-09-14

### Fixed

- Align Docker with Node 22 and pin SQLite to 12.8.0 so native dependencies install consistently.
- Include the final CI action updates alongside the Hermes morning commute homepage release.

## [2026.9.16] - 2026-09-14

### Added

- DeskRPG for Hermes morning commute homepage: a Three.js city district, six animated office characters, and smooth pointer-driven camera movement.
- Responsive public and login layouts, reduced-motion support, and WebGL context recovery.

### Changed

- The public launch screen can be enabled at runtime with `COMING_SOON=true`, using the same release image as self-hosted offices.
- Homepage metadata and translations now describe the Hermes 3D office.
- Pin Next.js build and output tracing to the project root to avoid parent-workspace dependency resolution errors.

## [2026.9.15] - 2026-09-15

### Added

- 3D office client: three.js renderer on top of the existing Phaser simulation (movement, seating and collisions unchanged), 50 stylized office looks as GLB characters, five curated environments, 3D meeting room.
- Hermes gateway setup wizard (`/gateways`): discover a local or SSH-reachable Hermes install, pre-check the DeskRPG plugin and services, register profiles. Off by default (`DESKRPG_HOST_SETUP_ENABLED=1`, `system_admin` only).
- Chat rooms (`room:*`): office room with mention-only replies, invite-based group rooms, six-stage response receipts and per-session request queue.
- Hostinger deployment recipe: `deploy/hostinger/docker-compose.yml` (single file, bundled Hermes gateway, Traefik labels) and a Deploy on Hostinger button.

### Changed

- OpenClaw runtime retired; DeskRPG now binds NPCs to Hermes Agent profiles only.
- README rewritten for the 3D, Hermes-only office.

### Removed

- Internal development plans are no longer tracked.

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
