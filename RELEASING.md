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

## v0.1.6 Release Checklist

Before tagging `0.1.6`, verify:

1. `package.json` version is `0.1.6`
2. `README.md` and `README.ko.md` reflect the current Docker flow
3. Docker self-hosting smoke tests have passed
   - SQLite: `docker/docker-compose.lite.yml`
   - PostgreSQL: `docker/docker-compose.external.yml`
4. The working tree is clean enough to release
5. The release commit is already on `master`

## Release Steps

Run these commands from the repo root:

```bash
git checkout master
git pull origin master
git status
git tag 0.1.6
git push origin master
git push origin 0.1.6
```

## What Happens After Tag Push

When the `0.1.6` tag is pushed:

1. GitHub Actions runs `Publish Docker Image`
2. The workflow builds the production image from [Dockerfile](Dockerfile)
3. The image is pushed to Docker Hub with these tags:
   - `dandacompany/deskrpg:0.1.6`
   - `dandacompany/deskrpg:sha-<gitsha>`
4. If the tag is also on the default branch, `latest` is updated by the branch push workflow

## Post-Release Verification

After the workflow succeeds, verify Docker Hub delivery:

```bash
docker pull dandacompany/deskrpg:0.1.6
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
JWT_SECRET=change-me DESKRPG_IMAGE=dandacompany/deskrpg:0.1.6 \
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
4. Push a new tag such as `0.1.6`
5. If needed, pin deployments with `DESKRPG_IMAGE=dandacompany/deskrpg:<known-good-tag>`

## Notes

- The release tag format is currently `0.1.6`, not `v0.1.6`
- The Docker image is intended to be the primary self-hosting path
- The compose files now default to `dandacompany/deskrpg:latest`
