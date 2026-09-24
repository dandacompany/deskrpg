#!/usr/bin/env bash
# Keep development metadata out of commit messages. This repo is public.
#
# The public tree check (check-public-tree.sh) only looks at files. But commit messages are public too,
# and once pushed a message cannot be taken back without rewriting history — commits carrying session
# trailers really did pile up on public master. This check guards it instead of human memory.
#
# Input: one or more messages on stdin. Comment lines (#) that git adds are ignored.
# Used by: .githooks/commit-msg (every commit), .githooks/pre-push (every commit being pushed —
#          rebase and cherry-pick do not rerun commit-msg, so this is the last gate).
set -euo pipefail

# Each line: description<TAB>ERE
patterns=$(cat <<'P'
세션 트레일러	Claude-Session:|session_01[A-Za-z0-9]
비공개 보드 식별자	(^|[^A-Za-z0-9])(PVT|PVTI|PVTSSF|PVTF|DI)_[A-Za-z0-9]{6,}
비공개 문서 경로(docs/ 는 공개 트리에 없다)	(^|[^A-Za-z0-9_./-])docs/
하네스 작업 폴더	\.superpowers/|\.dryforge/
P
)

body=$(grep -v '^#' || true)
found=0
while IFS=$'\t' read -r label regex; do
  [ -z "$label" ] && continue
  hits=$(printf '%s\n' "$body" | grep -nE -- "$regex" || true)
  if [ -n "$hits" ]; then
    found=1
    printf '커밋 메시지에 개발 메타가 있습니다 — %s:\n%s\n' "$label" "$hits" >&2
  fi
done <<< "$patterns"

if [ "$found" -ne 0 ]; then
  cat >&2 <<'MSG'

이 레포는 공개라 커밋 메시지도 그대로 공개됩니다. 해당 줄을 지우세요.
카드와의 연결은 반대 방향으로 합니다 — 카드 본문에 커밋 SHA 를 적습니다.
MSG
  exit 1
fi
