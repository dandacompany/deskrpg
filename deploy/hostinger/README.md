# DeskRPG on Hostinger VPS (Docker Manager)

One VPS, two containers: **DeskRPG** (the virtual office) and **Hermes Agent** (the employees' brain). Everything runs 24/7 on the server, so your agents keep working and reporting after you close the laptop.

## 1. Traefik comes after DeskRPG

Traefik gives the office its HTTPS address, but hPanel shows the _"Enable HTTPS for Docker projects"_ banner with its **Deploy Traefik** button only **once a project exists** (seen 2026-09-17). So deploy DeskRPG first (step 2), then:

1. Press **Deploy Traefik** on the banner under the project list (it asks only for `ACME_EMAIL`).
2. Press **Update** on the DeskRPG project once so `traefik-connect` runs against the new Traefik (only bridge-mode Traefik needs it; host mode routes immediately). If `TRAEFIK_HOST` was left empty in step 2-1, fill it in **Manage** → Environment → **Save and deploy** instead — it is required (step 3).

After the DeskRPG deploy the project shows three containers: `deskrpg` and `hermes` running, and `traefik-connect` **exited** — that one-shot is supposed to be stopped. A VPS that already has Traefik shows no banner; just press Update.

### Both Traefik shapes work (measured 2026-09-17)

Two Traefik shapes show up on Hostinger VPSes, and each one breaks a naive compose:

| Traefik shape                                                                             | How it reaches DeskRPG          | What breaks it                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **host mode** — `network_mode: host`, no networks (what hPanel installed on a user's VPS) | the container's bridge IP       | declaring `traefik-proxy` as `external: true` — `network traefik-proxy declared as external, but could not be found`, shown by Hostinger only as a project stuck at `created` whose logs read "Docker project not found" |
| **bridge mode** — Traefik on a `traefik-proxy` network                                    | only containers on that network | letting this compose create `traefik-proxy` (Compose refuses to adopt a network it did not create), or joining it without the `traefik.docker.network` label (Traefik dials the wrong IP)                                |

So the compose declares no Traefik network. Instead the one-shot `traefik-connect` service joins `deskrpg` to `traefik-proxy` **only when that network exists**, and the `traefik.docker.network=traefik-proxy` label tells bridge-mode Traefik which IP to use; host mode ignores a label naming a missing network.

Measured with both shapes: first deploy, full recreate, a new image recreating only `deskrpg`, container restart, and Hostinger's own **Update** all routed 10/10 — Update re-runs the exited connector. One gap: `docker compose up -d deskrpg` **with a service name** does not run the connector, so bridge-mode Traefik loses the route. Run `docker compose up -d` without a service name, or press Update.

`traefik-connect` mounts the Docker socket **read-write** (`docker network connect` writes), which is host-root equivalent. It runs only the fixed script in the compose and exits within seconds.

## 2. One-click

[![Deploy on Hostinger](https://assets.hostinger.com/vps/deploy.svg)](https://www.hostinger.com/vps/docker-hosting?compose_url=https://raw.githubusercontent.com/dandacompany/deskrpg/refs/heads/master/docker-compose.yml)

No VPS yet? [Get one here first](https://hostinger.com/DANTE-DOCKER) — a referral link that supports this project at no extra cost to you. It lands on Hostinger's offer page, not on Docker Manager, so buy there and then press the button above.

The button opens Docker Hosting. Pick **KVM 2** (2 vCPU / 8 GB — Hostinger's own minimum for Hermes), finish checkout, and Docker Manager opens with this compose already loaded.

Already have a VPS? hPanel → VPS → **Docker Manager** → **Compose** → **Compose from URL** → paste:

```
https://raw.githubusercontent.com/dandacompany/deskrpg/refs/heads/master/docker-compose.yml
```

Project name: `deskrpg` (3–64 chars, letters/digits/`-`/`_`).

## 2-1. Before you press Deploy

The **Environment** box is pre-filled from `.env.example` with every variable this compose reads, so you never need **+ Environment**. Fill two values:

```
HERMES_API_KEY=<output of: openssl rand -hex 32>
TRAEFIK_HOST=srvNNNNNN.hstgr.cloud   # the name in the hPanel breadcrumb: VPS › srvNNNNNN.hstgr.cloud › Docker Manager
```

- `DESKRPG_IMAGE` — pre-filled with `ghcr.io/dandacompany/deskrpg:latest`; leave it. Change it only to pin or roll back a release (step 7).
- `JWT_SECRET` — leave the placeholder. The app generates a real key into the `deskrpg-data` volume and reuses it across restarts and Update. A value you set always wins.
- `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — optional; see step 4-1 for which one to fill, or leave all empty to log in with ChatGPT.
- `HERMES_DASHBOARD_PASSWORD` — optional. Set it to open the Hermes dashboard at `https://deskrpg-hermes.<TRAEFIK_HOST>` (user `admin`). Empty keeps the dashboard off: Hermes refuses an unauthenticated public dashboard, so the compose only starts it when a password exists.

## 3. Your HTTPS URL

After Traefik (step 1) and Deploy (step 2), the office is reachable at:

```
https://deskrpg.<srvNNNNNN.hstgr.cloud>
```

**`TRAEFIK_HOST` is not injected — set it yourself.** Measured 2026-09-17: with Traefik running and the variable empty, the routing rule becomes `deskrpg.localhost`, Traefik answers 404 and Docker Manager's **Open** link points at `deskrpg.localhost`. Fill `TRAEFIK_HOST=srvNNNNNN.hstgr.cloud` (the name in the hPanel breadcrumb) in the Environment box — before the first deploy, or later via **Manage** → **Save and deploy**; Let's Encrypt then issues the certificate.

Custom domain: point an `A` record at the VPS IP and change the `Host(...)` rules to your domain.

## 4. Firewall

hPanel → VPS → Security → Firewall: allow **22, 80, 443** only. Do **not** open 3000, 3001, 8642 or 9119 — Traefik is the only public door, and Hermes' API server is reachable from DeskRPG on the private Docker network.

## 4-1. Give Hermes a model

Hermes boots without any provider, and then answers every message with `Provider authentication failed`. Pick **one** route (all measured 2026-09-17). Terminal commands run over SSH from the project folder:

```bash
ssh root@<VPS IP>
cd /docker/deskrpg          # Docker Manager keeps each project in /docker/<project name>
```

**A. ChatGPT login (Codex OAuth)** — no API key. **Hermes signs in each employee (profile) separately**: since upstream [93889b77](https://github.com/NousResearch/hermes-agent/commit/93889b770d) a profile no longer inherits the default profile's `auth.json`. Logging in only as the default profile and then hiring `noah` left `noah` answering `No Codex credentials stored` (measured 2026-09-17), so log in **after** hiring, as that employee:

1. Hire the employee in DeskRPG (step 5). Step ③ of the hire wizard shows **Sign in <name> on dashboard ↗**, which opens the dashboard's Keys page with that profile selected (`https://<project>-hermes.<TRAEFIK_HOST>/env?profile=<name>`). Without the dashboard, switch the profile selector at the top-left of the dashboard to the employee first.
2. **ChatGPT or Codex Subscription** → **Login** → approve on OpenAI with the shown code. The Keys header turns to `1/8` for that profile.
3. Back in the wizard press **Check sign-in**, pick `openai-codex` and a model (e.g. `gpt-5.5`), **Save**. No gateway restart is needed — the employee answered right after the login in the test.

Repeat for every employee that should use the subscription. The CLI equivalent targets the profile through `HERMES_HOME`:

```bash
P=noah
docker compose exec -e HERMES_HOME=/opt/data/profiles/$P hermes hermes auth add openai-codex --type oauth --no-browser
docker compose exec -e HERMES_HOME=/opt/data/profiles/$P hermes hermes config set model.provider openai-codex
docker compose exec -e HERMES_HOME=/opt/data/profiles/$P hermes hermes config set model.default gpt-5.5
```

Skipping the model lines leaves the profile on Hermes' default model (`anthropic/claude-opus-4.6`), which Codex rejects with `model is not supported when using Codex`. Logins live in `hermes-data` and survive Update.

**B. API key** (filled in the Environment box before Deploy):

| Key                  | Extra steps                                                                        |
| -------------------- | ---------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY` | none                                                                               |
| `ANTHROPIC_API_KEY`  | none; set `model.provider anthropic` and `model.default` to avoid the Opus default |
| `OPENAI_API_KEY`     | **required** — the key alone is ignored and requests still go to OpenRouter        |

```bash
# OpenAI key only
docker compose exec hermes hermes config set model.provider openai-api
docker compose exec hermes hermes config set model.default gpt-5.5
docker compose exec hermes hermes config unset model.base_url   # otherwise the key is not sent
```

`docker compose exec` as root is fine: the image's `hermes` wrapper drops to the `hermes` user, so file ownership stays correct.

## 4-2. The DeskRPG plugin installs itself

DeskRPG reads the Hermes profile list, kanban, cron and events through [`deskrpg-hermes-plugin`](https://github.com/dandacompany/deskrpg-hermes-plugin). Without it a gateway connection is saved but never reaches the profile list, and on a VPS the offered **Install via SSH** button is disabled. So the compose runs a one-shot `hermes-plugins` service before Hermes starts: it installs the plugin (or updates it when already installed — a second `install` exits 1), enables it, and exits. Nothing to type.

`hermes-plugins` gets the same `API_SERVER_KEY` as `hermes`. Without it the image generates a random key into the volume's `.env`, which then overrides `HERMES_API_KEY` and DeskRPG gets 401 — found while testing this service (2026-09-17). Verify from the project folder:

```bash
docker compose exec hermes sh -lc 'curl -s -H "Authorization: Bearer $API_SERVER_KEY" http://127.0.0.1:8642/deskrpg/info'
```

`capabilities` lists `kanban`, `cron`, `events`, `swarm`.

## 5. Connect the office to Hermes

1. Open your DeskRPG URL, create the first account (it becomes admin).
2. Top-right menu → **My Gateways** → **New gateway** → URL `http://hermes:8642`, token = your `HERMES_API_KEY` → **Test connection**.
3. Open the profile list (each Hermes profile = one employee). The plugin installed in step 4-2 discovers it automatically.
4. Enter a channel → Settings → **AI Connection** → attach the gateway → hire NPCs.

Already running Hermes elsewhere (your laptop, another VPS)? Delete the `hermes` service from the compose and use your own API server URL in step 2. Hermes profiles you already have show up as employees — nothing to migrate.

## 6. Kanban and cron

With the plugin from step 4-2 in place, kanban boards, the event stream and schedules work out of the box. Set `timezone:` in Hermes' `config.yaml` if you schedule anything — cron times are read in that zone.

## 7. Day-2: updating

The compose uses `ghcr.io/dandacompany/deskrpg:latest` and `nousresearch/hermes-agent:latest`. Docker Manager's **Update** keeps the compose you imported and pulls its images again (its build log shows `Pulling`), so:

| Goal                              | Do this                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Upgrade to the newest release** | project **⋮ → Update**. Only containers whose image changed are recreated                                       |
| **Stay on a release**             | Manage → Environment → change `DESKRPG_IMAGE` to `ghcr.io/dandacompany/deskrpg:<release tag>` → Save and deploy |
| **Roll back**                     | same as above with the previous tag from [releases](https://github.com/dandacompany/deskrpg/releases)           |
| **Follow latest again**           | set `DESKRPG_IMAGE` back to `ghcr.io/dandacompany/deskrpg:latest` → Save and deploy                             |

Data lives in the named volumes `deskrpg-data` (SQLite, uploads, generated `JWT_SECRET`) and `hermes-data` (`~/.hermes`, logins, plugins) and survives Update; database migrations run at startup. Rolling back to a release older than the one that migrated your database is not guaranteed to work — back up first (hPanel → VPS → Backups).

**Installed before 2026-09-17?** Update never re-reads the compose, so your saved file lacks `:latest`, the plugin service and the dashboard route. Project → **Manage** → **.yaml editor** → replace the contents with the current [`docker-compose.yml`](https://raw.githubusercontent.com/dandacompany/deskrpg/refs/heads/master/docker-compose.yml) → **Save and deploy**. Volumes and the environment box are kept. Do not delete the project to re-import it — deleting removes its volumes.

Other options on the project: Restart / View logs / Delete, and **Terminal** for a shell in a container.

## How Docker Manager reads this repo (measured 2026-09-16)

- **It always takes the repo-root `docker-compose.yml`.** A raw URL for a file in a
  subdirectory is resolved back to the root — a URL for
  `deploy/hostinger/docker-compose.yml` deployed the root file instead. That is why the
  compose lives at the repo root and must stay there.
- **It pre-fills the Environment box from the repo-root `.env.example`, verbatim.** That box
  has no comment syntax, so a line starting with `#` becomes a variable named `# FOO` and is
  rejected as an invalid name. `.env.example` is therefore kept comment-free; the prose lives
  in [`ENVIRONMENT.md`](../../ENVIRONMENT.md).
- The API takes the compose as a URL, a GitHub repository URL, or raw YAML, and `environment`
  as one `KEY=value` string. **Both** `environment` and raw-YAML `content` are capped at
  **8 192 characters** — a 8 654-character compose was rejected with `The content field must
not be greater than 8192 characters` (2026-09-17). Keep long explanations here, not in the
  compose; `src/lib/hostinger-compose.test.js` enforces the cap.
- `build:` is used by Hostinger's own template repo, so it is presumably supported. This
  compose does not use it — a published image is faster to deploy and easier to pin.

## Constraints baked into the compose

- Every `${VAR}` has a default so an empty environment box still boots.
- App ports are not published; Traefik routes `/socket.io` to the internal Socket.IO port (3001) and everything else to Next.js (3000), same-origin.
- SQLite mode; switch to Postgres by adapting `docker/docker-compose.external.yml` if you need multi-instance.
