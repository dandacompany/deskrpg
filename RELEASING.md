# Releasing DeskRPG

This document describes the current Docker image release flow for DeskRPG.

## Release Target

DeskRPG currently publishes a Docker image to:

- `dandacompany/deskrpg:latest`
- `dandacompany/deskrpg:<semver>`
- `dandacompany/deskrpg:sha-<gitsha>`

The image is built by GitHub Actions from:

- [.github/workflows/docker-image.yml](.github/workflows/docker-image.yml)

## Required Secrets

The GitHub repository must have these Actions secrets:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

## v2026.4.6 Release Checklist

Before tagging `2026.4.6`, verify:

1. `package.json` version is `2026.4.6`
2. `README.md` and `README.ko.md` reflect the current Docker flow
3. Run `npm run tc pre-deploy` (this executes automatable deploy checks from
   [Deploy pre-checklist](deploy/pre-deploy-checklist.md))
4. [Deploy pre-checklist](deploy/pre-deploy-checklist.md) manual items passed
5. The working tree is clean enough to release
6. The release commit is already on `master`

For pre-release image validation, use the test-only path:

```bash
npm run tc test-deploy -- --build --image deskrpg:tc-$(git rev-parse --short HEAD)
```

This smoke-checks a non-release image on isolated test ports and does not gate the production release flow.

## Release Steps

Run these commands from the repo root:

```bash
git checkout master
git pull origin master
git status
git tag 2026.4.6
git push origin master
git push origin 2026.4.6
```

## What Happens After Tag Push

When the `2026.4.6` tag is pushed:

1. GitHub Actions runs `Publish Docker Image`
2. The workflow builds the production image from [Dockerfile](Dockerfile)
3. The image is pushed to Docker Hub with these tags:
   - `dandacompany/deskrpg:2026.4.6`
   - `dandacompany/deskrpg:sha-<gitsha>`
4. If the tag is also on the default branch, `latest` is updated by the branch push workflow

## Post-Release Verification

After the workflow succeeds, verify Docker Hub delivery:

```bash
docker pull dandacompany/deskrpg:2026.4.6
docker pull dandacompany/deskrpg:latest
```

Then smoke-test both deployment modes:

### PostgreSQL

```bash
cp .env.example .env.docker
# edit JWT_SECRET and POSTGRES_PASSWORD
docker compose --env-file .env.docker up -d
curl -I http://localhost:3102
```

Expected result:

- `HTTP/1.1 307 Temporary Redirect`
- redirect location `/auth`

### SQLite

```bash
JWT_SECRET=change-me DESKRPG_IMAGE=dandacompany/deskrpg:2026.4.6 \
docker compose -f docker/docker-compose.lite.yml up -d
curl -I http://localhost:3102
```

Expected result:

- `HTTP/1.1 307 Temporary Redirect`
- redirect location `/auth`

## Rollback

If a bad image is published:

1. Do not reuse the same semver tag
2. Fix the issue on `main`
3. Bump the version
4. Push a new tag such as `2026.4.6`
5. If needed, pin deployments with `DESKRPG_IMAGE=dandacompany/deskrpg:<known-good-tag>`

## Notes

- The release tag format is currently `2026.4.6`, not `v2026.4.6`
- The Docker image is intended to be the primary self-hosting path
- The compose files now default to `dandacompany/deskrpg:latest`
