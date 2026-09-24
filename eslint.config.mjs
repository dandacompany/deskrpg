import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // We actually hit the defect where a stale closure silently drops a value — the wizard showed
  // "저장했습니다" while not sending reasoning_effort (catalog was not in the
  // dependencies, so it held onto the initial render's null). The tile editor's
  // 17 existing violations were cleaned up too, and the rule was turned on globally.
  {
    files: ["**/*.tsx", "**/*.jsx"],
    rules: { "react-hooks/exhaustive-deps": "error" },
  },
  // Every <img> in this app is a **runtime data URL** — project thumbnails, stamp
  // thumbnails, user-uploaded tileset base64, images in markdown bodies. `next/image` cannot
  // optimize data: URIs, and remote pattern settings do not apply. In other words, the alternative
  // the rule recommends does not exist here.
  //
  // Disabling per site with comments was tried first, but most targets sit **inside ternaries**,
  // where both JSX comments and `//` are syntax errors (5 of 9 sites). So it is disabled in config.
  // If new code uses `<img>` for static assets, revisit this decision.
  {
    files: ["**/*.tsx"],
    rules: { "@next/next/no-img-element": "off" },
  },
  // In this repo an underscore prefix means "received but intentionally unused"
  // (`_fromStatus`, `_catId` …). Tell the rule about that convention.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  // `.js` in this repo is **CommonJS by design** — `server.js` requires it as-is at runtime,
  // with no build step. Forbidding `require` in those files would put the rule at odds with the facts,
  // so it is off. Intentional requires on the `.ts` side stay as per-site disables with a reason
  // (what is called and why must be visible in the file).
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Development metadata and working worktree copies. They are gitignored so CI never sees them, but
    // a local `npm run lint` sweeps them too and spits out 759 findings from other code —
    // then local and CI results differ and the gate cannot be trusted.
    ".claude/**",
    ".codex/**",
    ".superpowers/**",
    ".dryforge/**",
    ".artifacts/**",
    // Local-only development tools (.gitignore:58). Excluded for the same reason —
    // untracked so CI cannot see them, and if only local lint fails the gate loses trust.
    "scripts/local/**",
  ]),
]);

export default eslintConfig;
