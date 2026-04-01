# DeskRPG

한국어 문서: [README.ko.md](README.ko.md)

<img src="public/readme/home-screenshot.png" alt="DeskRPG home screen" width="100%" />

DeskRPG is a 2D pixel-art virtual office you can self-host. Create LPC characters, enter shared channels, walk around a live office map, hire AI NPC coworkers through OpenClaw, assign tasks, receive reports in-world, and run AI meetings in a browser.

DeskRPG is built for people who want a playful, self-hosted workspace rather than another plain chat room.

- Website: `https://deskrpg.com` (planned)
- Source code: `https://github.com/dandacompany/deskrpg`
- Version: `v0.1.1`

## What You Can Do

- Create your own pixel-art office avatar with LPC-based character customization.
- Join or self-host shared office channels with live multiplayer movement.
- Hire AI NPCs, connect them to OpenClaw agents, and talk to them in-world.
- Delegate tasks, request reports, resume stalled work, and review progress in a task board.
- Run AI meetings in a dedicated meeting room with meeting notes and multi-agent discussion.
- Build or upload your own office maps with the browser-based map editor.

## Screenshots

<table width="100%">
  <tr>
    <td width="50%" valign="top"><img src="public/readme/deskrpg-login-to-office.gif" alt="DeskRPG getting started" width="100%" /></td>
    <td width="50%" valign="top"><img src="public/readme/deskrpg-npc-task-loop.gif" alt="DeskRPG NPC chat and tasks" width="100%" /></td>
  </tr>
  <tr>
    <td width="50%" align="center"><strong>Getting Started</strong></td>
    <td width="50%" align="center"><strong>NPC Chat and Tasks</strong></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><img src="public/readme/deskrpg-meeting-room.gif" alt="DeskRPG meeting room" width="100%" /></td>
    <td width="50%" valign="top"><img src="public/readme/deskrpg-map-editor.gif" alt="DeskRPG map editor" width="100%" /></td>
  </tr>
  <tr>
    <td width="50%" align="center"><strong>Meeting Room</strong></td>
    <td width="50%" align="center"><strong>Map Editor</strong></td>
  </tr>
</table>

## Quick Start

Choose one of these six ways to start DeskRPG.

### Option 1: npm Install Runtime

This is the simplest self-hosted path if you want DeskRPG as an installed app instead of a cloned repo.

```bash
npx deskrpg init
npx deskrpg start
```

DeskRPG stores mutable runtime state under `~/.deskrpg/`:

- `~/.deskrpg/.env.local`
- `~/.deskrpg/data/deskrpg.db`
- `~/.deskrpg/uploads/`
- `~/.deskrpg/logs/`

Open `http://localhost:3000`.

Published npm package: `deskrpg`

### Option 2: Local Run with PostgreSQL

```bash
git clone https://github.com/dandacompany/deskrpg.git
cd deskrpg
npm install
cp .env.example .env.local
npm run setup
npm run dev
```

Open `http://localhost:3000`.

This is the best option if you want to run the full app directly from the repo.

### Option 3: Local Run with SQLite

```bash
git clone https://github.com/dandacompany/deskrpg.git
cd deskrpg
npm install
npm run setup:lite
npm run dev
```

SQLite stores data in `data/deskrpg.db`.

### Option 4: Docker with PostgreSQL

Recommended if you expect multiple users or want a more durable database.

```bash
cp .env.example .env.docker
docker compose --env-file .env.docker up -d
```

Before the first run, open `.env.docker` and set:

- `JWT_SECRET`
- `POSTGRES_PASSWORD`

DeskRPG will open on `http://localhost:3102`.

The default image is `dandacompany/deskrpg:latest`.
If you want to pin a release, change `DESKRPG_IMAGE` in `.env.docker` to something like `dandacompany/deskrpg:0.1.1`.

If you prefer the explicit file path version, you can run:

```bash
docker compose --env-file .env.docker -f docker/docker-compose.external.yml up -d
```

### Option 5: Docker with PostgreSQL and OpenClaw

Use this stack if you want DeskRPG, PostgreSQL, and an OpenClaw gateway in one compose setup.

```bash
cp .env.example .env.docker
docker compose --env-file .env.docker -f docker/docker-compose.openclaw.yml up -d --build
```

Before the first run, open `.env.docker` and set:

- `JWT_SECRET`
- `POSTGRES_PASSWORD`
- `OPENCLAW_TOKEN`

Default endpoints:

- DeskRPG: `http://localhost:3102`
- OpenClaw: `http://localhost:18789/openclaw?token=<OPENCLAW_TOKEN>`

This stack has been verified end to end, but OpenClaw still needs provider/model onboarding before AI features will work.

1. Open `http://localhost:18789/openclaw?token=<OPENCLAW_TOKEN>`.
2. Complete provider and model onboarding in the OpenClaw dashboard.
3. Then save these values inside DeskRPG from `Settings -> Channel Settings -> AI Connection`:

- `OpenClaw Gateway URL`: `http://localhost:18789`
- `Token`: the same `OPENCLAW_TOKEN` from `.env.docker`

Until this is done, NPC hiring, task automation, and AI meetings will not work.

### Option 6: Docker with SQLite

Recommended if you want the simplest single-machine setup.

```bash
JWT_SECRET=change-me docker compose -f docker/docker-compose.lite.yml up -d
```

DeskRPG will open on `http://localhost:3102`.

To pin a specific image version, add `DESKRPG_IMAGE=dandacompany/deskrpg:0.1.1` before the command.

Use SQLite if you want to get started quickly. Use PostgreSQL if you want a setup that is easier to keep long term.

### Environment

Important environment variables:

- `JWT_SECRET`
- `POSTGRES_PASSWORD` (PostgreSQL Docker setup)
- `OPENCLAW_TOKEN` (integrated OpenClaw Docker setup)

For production, always set a real `JWT_SECRET`.

OpenClaw gateway URL and token are configured inside the app from `설정 -> 채널 설정 -> AI 연결`.
Even in the integrated Docker setup, provider/model onboarding is still completed in the OpenClaw dashboard.

## OpenClaw Connection

AI NPCs, task automation, and AI meetings depend on an OpenClaw gateway connection.

After entering a channel:

1. Open `Settings` in the top-right menu.
2. Open `Channel Settings`.
3. Go to `AI Connection`.
4. Enter:
   - `OpenClaw Gateway URL`
   - `Token`
5. Save and test the connection.

Once connected, you can hire NPCs and bind them to available OpenClaw agents.

## How DeskRPG Works

### 1. Characters

- Every user enters as a character.
- Character appearance is LPC-based and composed from layered sprite parts.
- Character creation is required before entering a channel.

### 2. Channels

- A channel is a shared office space.
- Channels can be public or restricted depending on access and group rules.
- Channel maps come from map templates.

### 3. AI NPCs

- NPCs live inside channels.
- NPCs can be connected to OpenClaw agents.
- NPCs can be called over, sent back, edited, reset, and fired from in-app menus.

### 4. Tasks

- You can assign work to NPCs through conversation.
- Tasks move through `대기`, `진행중`, `중단`, `완료`.
- NPCs can be nudged automatically or manually to continue working.
- Important reports are delivered in-world by the NPC walking over to the player.

### 5. Meetings

- DeskRPG includes a dedicated meeting room.
- AI meetings are channel-scoped and orchestrated through OpenClaw.
- Meeting notes are stored and visible from the header.

### 6. Map Editor

- The browser map editor supports Tiled-style map workflows.
- You can upload templates, manage project-linked assets, and reuse maps for new channels.
- This is a major subsystem of the project, not a side tool.

## Product Notes

- Login is required even if you have an invite code.
- Invite codes are channel access helpers, not anonymous access tokens.
- The current default in-app office tiles and object textures are generated in code at runtime.
- LPC avatar sprite assets are bundled separately and have their own credits and license notes.

## Licenses And Credits

- Project license: [LICENSE.md](LICENSE.md)
- Third-party licenses: [public/third-party-licenses.html](public/third-party-licenses.html)
- LPC avatar credits: [public/assets/spritesheets/CREDITS.md](public/assets/spritesheets/CREDITS.md)
- LPC avatar license notes: [public/assets/spritesheets/LICENSE-assets.md](public/assets/spritesheets/LICENSE-assets.md)
- Full LPC credits data: [public/assets/spritesheets/CREDITS.csv](public/assets/spritesheets/CREDITS.csv)

## Support

- YouTube: [@dante-labs](https://youtube.com/@dante-labs)
- Email: `dante@dante-labs.com`
- Buy Me a Coffee: `https://buymeacoffee.com/dante.labs`
