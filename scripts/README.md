# Scripts

This folder is split by purpose.

- `setup/`
  - Public setup scripts that are safe to keep in the repository.
- `assets/`
  - No public scripts currently remain in this folder.
- `deprecated/`
  - No tracked deprecated scripts currently remain.
- `local/`
  - Personal admin and diagnostic scripts.
  - Ignored by Git and not part of the open-source distribution.

Current public entry points:

- `node scripts/setup/setup-lite.js`
- `bash scripts/tc` (run `npm run tc pre-deploy` for pre-deploy automated checks)

Current local-only examples:

- `scripts/local/seed-channel.ts`
- `scripts/local/task-workflow-api-socket-check.ts`
