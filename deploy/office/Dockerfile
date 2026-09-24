# DeskRPG Office — the office (DeskRPG) and the brain (Hermes Agent) in one container.
#
# DeskRPG can do nothing without Hermes. Deployed separately, users must match addresses, keys and versions
# by hand, and most get stuck there. So we start from the official Hermes image and add DeskRPG on top,
# making the gateway, dashboard and office start and stop with the same lifecycle.
#
# Do not rebuild what the official image already has: the s6 supervision tree, the dashboard service,
# Node 26, the HERMES_HOME (/opt/data) volume. We add one service (deskrpg) and one init hook.
#
# Build for amd64. The arm64 variant of the official latest is a 2026-06 version (below 0.21.1), so the plugin
# does not load (measured). VPSes are amd64 so this is fine, but building as-is on Apple Silicon
# lays down a stale base.
FROM --platform=linux/amd64 nousresearch/hermes-agent:latest

LABEL org.opencontainers.image.title="DeskRPG Office" \
      org.opencontainers.image.description="DeskRPG + Hermes Agent in one container (gateway, dashboard, virtual office)" \
      org.opencontainers.image.source="https://github.com/dandacompany/deskrpg" \
      org.opencontainers.image.licenses="MIT"

# The latest DeskRPG at build time. Whether to update again on container start is decided by DESKRPG_AUTO_UPDATE.
# Baking right after a publish sees the dist-tag first while the tarball reaches the CDN late, giving a 404
# (measured: a build right after 2026.9.21). Wait briefly and retry.
RUN for attempt in 1 2 3 4 5; do \
      npm install -g deskrpg@latest && break; \
      echo "npm install 실패 ($attempt/5) — 30초 뒤 다시 시도"; \
      sleep 30; \
    done; \
    npm ls -g deskrpg >/dev/null \
 && npm cache clean --force

# The office service and the init hook
COPY s6-rc.d/deskrpg /etc/s6-overlay/s6-rc.d/deskrpg
COPY s6-rc.d/hermes-gateway /etc/s6-overlay/s6-rc.d/hermes-gateway
COPY scripts/start-gateway /opt/deskrpg/start-gateway
COPY cont-init.d/03-deskrpg-setup /etc/cont-init.d/03-deskrpg-setup
RUN chmod +x /etc/s6-overlay/s6-rc.d/deskrpg/run /etc/s6-overlay/s6-rc.d/deskrpg/finish \
      /opt/deskrpg/start-gateway /etc/cont-init.d/03-deskrpg-setup \
 && touch /etc/s6-overlay/s6-rc.d/user/contents.d/deskrpg \
 && touch /etc/s6-overlay/s6-rc.d/user/contents.d/hermes-gateway

# 3000 office (HTTP) · 3001 socket · 8642 Hermes API · 9119 dashboard
EXPOSE 3000 3001 9119

ENV DESKRPG_HOME=/opt/data/deskrpg \
    DESKRPG_AUTO_UPDATE=true \
    HERMES_DASHBOARD=true \
    INTERNAL_HOSTNAME=0.0.0.0 \
    HOSTNAME=0.0.0.0

# The container's main program is the Hermes TUI (`hermes`). Without a TTY it exits immediately, and s6
# takes the whole container down when main ends — the office and the gateway die with it (measured: Exited (0)).
# Entering the TUI with `docker exec -it <container> hermes` is how this image is meant to be used,
# so main is left sleeping and s6 supervises the services. main-wrapper execs the first argument
# directly when it is an executable.
CMD ["sleep", "infinity"]
