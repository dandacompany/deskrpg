# DeskRPG — Project Guidelines

## Architecture

- **Framework**: Next.js 16 (App Router) + Phaser 3 + Socket.io
- **DB**: Drizzle ORM, dual support (PostgreSQL + SQLite)
- **Dev server**: `npx tsx dev-server.ts` — Next.js + Socket.io on same HTTP server
- **SQLite mode**: `DB_TYPE=sqlite SQLITE_PATH=data/deskrpg.db`

## Key Patterns

### Hard Navigation for Phaser Cleanup
`window.location.href` (하드 네비게이션)를 사용해야 Phaser 게임 인스턴스가 완전히 파괴됨. Next.js `Link`/`router.push` (클라이언트 라우팅)는 Phaser가 메모리에 남아서 EventBus 리스너 누적, 카메라 undefined 등 문제 발생.

### State 저장은 소켓 disconnect에 의존하지 말 것
`window.location.href`로 하드 네비게이션하면 소켓 `disconnect` 이벤트가 발생하기 전에 페이지가 unload됨. DB에 상태를 저장해야 하는 경우(플레이어 위치 등), **페이지 이동 전에 REST API로 명시적으로 저장**한 뒤 이동할 것. 소켓 disconnect 핸들러의 저장은 비정상 종료(탭 닫기, 네트워크 끊김) 백업용.

### SQLite JSON 컬럼 주의사항
- SQLite는 JSON을 `text`로 저장 → API 응답에서 string으로 올 수 있음 → 클라이언트에서 `JSON.parse()` 필요
- `updatedAt`에 `new Date()` 사용 불가 → `new Date().toISOString()` 또는 `as unknown as Date` 캐스팅
- `jsonForDb()` 헬퍼로 PG/SQLite 자동 처리

### EventBus Phaser↔React 통신
- Phaser 씬의 EventBus 리스너는 `Game.destroy()`로 자동 정리되지 않음
- 씬의 `shutdown`/`destroy` Phaser 이벤트에 cleanup 등록 필수
- React 컴포넌트 마운트 시 stale 리스너 먼저 제거 (`removeAllListeners`)
- `create()` 안에서 동기적으로 EventBus emit하면 race condition 발생 → `this.time.delayedCall(0, ...)` 사용

### Phaser HMR 미지원
Phaser 씬 코드 변경 시 HMR이 적용되지 않음. **Cmd+Shift+R (하드 리프레시)** 필요.

## Tiled Map Integration

### 맵 레이어 정책

| 레이어 이름 | 타입 | 렌더링 | Depth |
|------------|------|:------:|:-----:|
| `Floor` (또는 첫 번째 타일 레이어) | Tile Layer | 보임 | 0 |
| `Walls` (또는 두 번째 타일 레이어) | Tile Layer | 보임 | 1 |
| `Collision` | Tile/Object Layer | 숨김 | - |
| `Foreground` / `Above` / `Overlay` | Tile Layer | 보임 | 10000 |
| Object Layer | Object Layer | 오브젝트별 | y-sort |

- 레이어 이름 대소문자 무관, 매칭 실패 시 순서 기반 폴백
- 타일셋은 TMJ에 임베딩 권장 (외부 .tsx 참조 시 런타임에 DeskRPG 기본 타일셋으로 대체)

### 맵 업로드
- `.tmj`, `.tmx`, `.json`, `.zip` 지원
- ZIP: 맵 파일 + 타일셋 이미지 자동 추출, `public/assets/uploads/{id}/`에 저장
- 타일셋 이미지 경로가 절대 경로(`/assets/uploads/...`)면 GameScene이 동적 로드

## DB Schema 참고
- `channel_members.lastX/lastY` — 플레이어 마지막 위치
- `map_templates.tiledJson` — Tiled JSON 원본 저장 (새 맵 포맷)
- `map_templates.layers/objects` — 레거시 포맷 (nullable)
