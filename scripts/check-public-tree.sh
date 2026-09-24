#!/usr/bin/env bash
# Keep development-only docs and harness metadata files out of the public Git tree.
set -euo pipefail

violations=0
while IFS= read -r tracked_path; do
  case "$tracked_path" in
    docs/*|CLAUDE.md|AGENTS.md|GEMINI.md|*/CLAUDE.md|*/AGENTS.md|*/GEMINI.md|\
    .claude/*|.codex/*|.agents/*|.gemini/*|.superpowers/*|.dryforge/*|\
    deploy/pre-deploy-checklist.md|deploy/hostinger/catalog-submission.md|e2e/README.md)
      echo "공개 트리에 개발 메타 파일이 남았습니다: $tracked_path" >&2
      violations=$((violations + 1))
      ;;
  esac
done < <(git ls-files)

if [ "$violations" -ne 0 ]; then
  echo "개발 메타 파일 $violations 개를 Git 인덱스에서 제외하세요." >&2
  exit 1
fi

echo "공개 Git 트리에 개발 메타 파일이 없습니다."
