---
name: deskrpg-release
description: Use this skill when releasing DeskRPG, publishing a new npm version, pushing Docker Hub images, creating GitHub tags/releases, or validating the master branch before deployment. Trigger on requests like "deskrpg 배포", "release deskrpg", "npm publish", "docker hub 배포", "릴리스 노트", or version-specific release requests.
---

# DeskRPG Release

Use this skill for DeskRPG release work only.

## Release Branch Rule

- Release from `master` only.
- Do not release from feature branches.
- If feature work exists, move `master` to the verified release commit first.

## Pre-Release Checklist

1. Confirm branch and worktree state.
   - `git status --short --branch`
   - worktree must be clean except ignored local files
2. Confirm version strings.
   - `package.json`
   - `package-lock.json`
   - `README.md`
   - `README.ko.md`
   - `RELEASING.md`
   - `src/app/game/GamePageClient.tsx`
3. Run production build.
   - `npm run build`
   - If sandbox blocks Turbopack internals, rerun with escalated permissions
4. Validate npm package contents.
   - `npm pack --dry-run`
   - Check package size and confirm runtime assets are included

## DeskRPG-Specific Notes

- `public/assets/spritesheets/` is runtime-critical. If omitted, character creation/rendering breaks.
- Docker and npm packages currently include large runtime assets. Verify before publishing.
- README and README.ko should reflect the current shipping flow before release.

## Publish Order

Run these in order after the checklist passes.

### 1. npm

- npm publish is a manual user step.
- Before handing off, prepare and verify:
  - `npm whoami`
  - `npm pack --dry-run`
- Ask the user to run one of:
  - `npm publish --access public`
  - `npm publish --access public --otp=<CODE>`
- After the user publishes, verify:
  - `npm view deskrpg version`
  - `npm view deskrpg dist-tags --json`

### 2. Docker Hub

- Login:
  - `docker login -u dandacompany --password-stdin`
- Build:
  - `docker build -t dandacompany/deskrpg:<VERSION> -t dandacompany/deskrpg:latest .`
- Push:
  - `docker push dandacompany/deskrpg:<VERSION>`
  - `docker push dandacompany/deskrpg:latest`
- Record the digest if needed.

### 3. GitHub Tag And Release

- Tag:
  - `git tag <VERSION>`
  - `git push origin <VERSION>`
- Release:
  - `gh release create <VERSION> --title "DeskRPG <VERSION>" --notes-file <FILE>`
- Release notes should include:
  - version
  - major release highlights
  - build verification
  - npm publish status
  - Docker image tags

## Final Verification

- `git status --short --branch`
- `npm view deskrpg version`
- `npm view deskrpg dist-tags --json`
- check Docker Hub tags manually or by pull
- confirm the GitHub release URL

## Good Release Summary

A final summary should report:

- release branch and commit
- build result
- npm published version
- Docker tags pushed
- GitHub tag and release URL
- any remaining warnings such as Next workspace-root or middleware deprecation warnings
