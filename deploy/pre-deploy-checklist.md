# Pre-deploy Checklist

이 문서는 배포 전 점검 항목입니다. 배포 전에 자동화 가능한 항목은
`npm run tc pre-deploy`로 실행하고, 나머지는 문서 항목을 수동으로 확인합니다.

문서가 배포 이미지에는 포함되지 않도록 `.gitignore`로 관리합니다.

## 1) 배포 직전 자동 체크 (`npm run tc pre-deploy`)

스크립트가 통과해야 할 항목:

- `master` 브랜치에서 실행 중인지 확인
- Git 작업트리가 깨끗한지 확인 (`git status` no changes)
- `docker compose -f docker-compose.yml --env-file .env.production config` 실행 가능
- `JWT_SECRET`, `POSTGRES_PASSWORD`가 `.env.production`에 비어있지 않게 존재
- 배포용 Docker 이미지가 정상적으로 pull 가능한지 검증 (`docker pull ${DESKRPG_IMAGE:-dandacompany/deskrpg:latest}`)

## 2) 배포 스크립트 수동 체크 항목

- 배포 PR/요청 본문에 `deploy/pre-deploy-checklist.md` 결과 요약 반영
- 변경 건수가 `master`에 반영되었는지, 태그/버전 정보가 `package.json`과 일치하는지 확인
- `JWT_SECRET` / `POSTGRES_PASSWORD` 운영값과 일치하는지 확인
- OpenClaw/Provider 연동이 필요한 경우:
  - `OPENCLAW_TOKEN`, `OPENCLAW_MODEL`, `OPENCLAW_URL` 값 확인
  - 대시보드에서 페어링/온보딩 상태 점검
- 배포 후 초기 접근 경로 점검(`/auth` 리다이렉트 또는 대체 헬스체크)

## 3) 선택: 배포용 Smoke 테스트 (`tc` 플래그)

- `npm run tc pre-deploy -- --smoke` 실행 시 컨테이너 기동 후 응답 확인까지 수행
- 스모크 테스트는 실패 시 종료 코드와 로그를 확인하고 즉시 롤백 계획을 준비

## 4) 승인

- 자동화 체크와 수동 체크 모두 통과 후 배포 승인
