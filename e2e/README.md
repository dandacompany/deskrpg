# E2E — 브라우저에서 실제 NPC 대화를 검증한다

단위 테스트(`npm run test`, node:test)는 어댑터·엔진의 계약을 고정한다. 이 스위트는 그 위에서
**사람이 실제로 밟는 경로**를 검증한다 — 로그인한 채로 맵에 들어가, NPC 옆까지 걸어가, 말을
걸고, 살아 있는 Hermes 게이트웨이로부터 답을 받는 것까지.

여기 있는 회귀는 단위 테스트로는 잡히지 않았다. 어댑터는 처음부터 옳았고, 결함은 그것을
소비하는 쪽에 있었다.

## 실행

```bash
npm run dev          # 별도 터미널. 로컬 Hermes 게이트웨이도 떠 있어야 한다.
npm run test:e2e
```

## 전제

- `npm run dev` 가 `localhost:3000` 에 떠 있을 것
- 로컬 Hermes 게이트웨이가 살아 있고, 개발 DB 에 **Hermes 프로필이 묶인 NPC** 가 최소 하나 있을 것
- 개발 계정이 존재할 것

환경변수로 바꿀 수 있다:

| 변수                   | 기본값                  |
| ---------------------- | ----------------------- |
| `DESKRPG_E2E_BASE_URL` | `http://localhost:3000` |
| `DESKRPG_E2E_LOGIN_ID` | `devadmin`              |
| `DESKRPG_E2E_PASSWORD` | `deskrpg-e2e-2026`      |
| `DESKRPG_E2E_NPC`      | `단비`                  |

## CI 에 넣지 않은 이유

살아 있는 Hermes 게이트웨이와 시드된 DB 를 요구하고, 둘 다 CI 에 없다. `npm run test` 는 그대로
순수 단위 테스트로 남는다.

## 이 하네스를 만들며 실측한 함정 세 가지

기록해 두지 않으면 다음 사람이 같은 자리에서 같은 시간을 쓴다.

**1. `127.0.0.1` 이 아니라 `localhost` 로 붙어야 한다.**
브라우저에게 이 둘은 서로 다른 origin 이고, Next dev 서버는 `allowedDevOrigins` 에 없는
origin 의 dev 자원 요청을 막는다. 그러면 RSC 페이로드가 끝내 도착하지 않아 React 가 hydrate
전에 멈춰 선다 — **콘솔 에러 0, 실패한 요청 0, 청크는 21개 전부 200**. 화면에는 "로딩 중..."
만 남는다. 실측: 같은 서버에 `127.0.0.1` 로 붙으면 fiber=0/input=0, `localhost` 면 fiber=2/input=2.

**2. headed 로 돌리면 창이 가리는 순간 게임이 멈춘다.**
Chrome 은 가려진(occluded) 창의 `requestAnimationFrame` 을 초당 1프레임으로 스로틀한다.
Phaser 루프가 사실상 멈춰 캐릭터가 NPC 에게 걸어가지 못하고, 테스트는 "대화창이 안 열린다"는
엉뚱한 실패로 나타난다. `document.visibilityState` 는 그때도 `"visible"`, `document.hasFocus()`
는 `true` 라 코드로는 감지되지 않는다. 그래서 `waitForGameLoop()` 이 상태 플래그가 아니라
**프레임을 직접 센다** — 실패 원인을 그 자리에서 이름 붙이기 위해서다. headless 에는 가릴 창이
없으므로 기본값은 headless 다.

**3. 소켓 서버 코드는 HMR 로 갱신되지 않는다.**
`npm run dev` 는 `npx tsx dev-server.ts` 이고 watch 가 없다. Next 페이지는 HMR 로 갱신되지만
`src/server/socket-handlers.ts` 같은 서버 코드는 **재시작해야** 반영된다. 이 사실을 모르면
"고쳤는데 그대로다" 혹은 더 나쁘게 "버그를 되살렸는데 테스트가 통과한다"는 잘못된 결론에
도달한다 — 실제로 이 하네스의 첫 뮤테이션 검증이 그렇게 헛돌았다.
