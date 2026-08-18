# Hermes 프로필 발견·등록 설계

**상태:** 승인됨 (2026-08-18)
**선행 스펙:** [2026-08-17-deskrpg-hermes-migration-design.md](2026-08-17-deskrpg-hermes-migration-design.md)
**대상 페이즈:** P1 후속 (P3 이전에 넣을 수 있는 독립 작업)

## 1. 문제

`/gateways`에서 Hermes 게이트웨이를 등록한 뒤, 그 게이트웨이의 프로필을 쓰려면
**프로필 이름과 토큰을 손으로 입력**해야 한다. 게이트웨이 하나에 프로필이 N개
붙는 구조(`hermes_profiles.gateway_id` → `gateway_resources.id`)인데 하나씩
타이핑하는 것은 이 데이터 모델과 맞지 않는다.

오타는 조용히 실패한다. 없는 프로필 이름으로 등록해도 저장은 되고, 그 NPC에게
말을 걸었을 때 비로소 실패한다.

## 2. 조사 결과 — 왜 이 형태인가

설계를 정하기 전에 자동화 가능 경로를 전부 확인했다. 결론이 설계를 결정했으므로
근거를 남긴다.

### 2.1 API Server에는 프로필 열거가 없다

`gateway/platforms/api_server.py`의 상단 독스트링이 정본 라우트 목록(24개)이고,
살아 있는 게이트웨이의 `GET /v1/capabilities` 응답 `endpoints` 맵도 같다.
프로필을 나열하는 엔드포인트는 **없다**.

`GET /v1/models`는 리스너 자신의 프로필 하나만 돌려준다(실측: `{"id": "sophie"}`).
서빙 중인 프로필 목록이 아니다.

### 2.2 대시보드 RPC(`profiles.list`)는 외부 서버에게 닫혀 있다

`tui_gateway/methods_profiles.py`에 `profiles.list` / `create` / `describe` /
`configure`가 있고, Hermes Bot Mode가 이것을 쓴다. 그러나 그 문(`/api/ws`)의
인증은 외부 서버를 상정하지 않는다.

- `hermes_cli/dashboard_auth/token_auth.py` — 머신 베어러 토큰은 **라우트별 옵트인**이고
  ("Only registered paths are token-authable"), 실제로 옵트인한 곳은
  `plugins/dashboard_auth/drain/` **한 곳뿐**이다. `/api/ws`는 포함되지 않는다.
- `hermes_cli/dashboard_auth/ws_tickets.py` — WS 자격증명은 두 형태뿐이다.
  단발 티켓은 `POST /api/auth/ws-ticket`로 받는데 그 자체가 **세션 쿠키 인증**을
  요구한다(사람 로그인 전제). 프로세스 내부 자격증명은 **대시보드가 직접 띄운
  자식**(임베디드 TUI PTY) 전용이며 "never injected into any HTML/SPA"라고 못박혀 있다.

Bot Mode가 이 문을 쓸 수 있는 이유는 **데스크톱 앱 안에서 도는 플러그인**이라
이미 인증된 세션을 물려받기 때문이다. DeskRPG는 제3의 서버이므로 같은 자격을
가질 수 없다.

**따라서 `profiles.*` RPC는 채택하지 않는다.**

### 2.3 남는 두 경로

| 경로 | 로컬 | 원격 | 얻는 것 |
|---|:---:|:---:|---|
| 파일시스템 (`<루트>/profiles/`) | O | X | 이름 + 토큰 |
| 게이트웨이 탐침 (`/p/<이름>/health`) | O | O | 존재 여부 |

실측: `/p/sophie/health` → 200, `/p/nosuch/health` → 404.

## 3. 결정

| # | 결정 | 근거 |
|---|---|---|
| D1 | 로컬이면 파일시스템으로 목록+토큰 자동, 원격이면 입력 즉시 검증 | 2.3 |
| D2 | 비밀 파일 읽기는 **게이트웨이별 명시적 옵인**, 소유자만 | 아래 5 |
| D3 | 프로필 **바인딩만**. 생성·편집은 범위 밖 | 셸 호출 인젝션 비용 + 원격 불가 |
| D4 | @멘션 피어 대화는 **별도 스펙** | 범위 분리 |
| D5 | `profiles.*` RPC 미채택 | 2.2 |

## 4. 판별 — 언제 "로컬"인가

URL만으로 판단하면 Docker에서 틀린다. DeskRPG가 컨테이너 안이면 `127.0.0.1`은
호스트가 아니라 컨테이너다.

```
1단계  URL 호스트가 루프백인가          127.0.0.1 / localhost / ::1 / 0.0.0.0
2단계  프로필 루트가 실제로 존재하는가   ← 진짜 판정
```

2단계가 **능력 검사**다. 컨테이너에는 `~/.hermes`가 없으므로 자동으로 원격 모드로
떨어진다. 별도 분기 없이 스스로 교정된다.

### 4.1 프로필 루트 해석

Hermes의 규칙을 그대로 따른다 (`hermes_cli/profiles.py:_get_profiles_root`):

```
루트 = (HERMES_HOME이 설정되어 있고 ~/.hermes 밖을 가리키면 그 경로,
        아니면 ~/.hermes)
프로필 디렉토리 = 루트/profiles/
```

주석이 이유를 밝힌다 — "In Docker/custom deployments where HERMES_HOME points
outside ``~/.hermes``, profiles live under ``HERMES_HOME/profiles/`` so they
persist on the mounted volume."

## 5. 옵인

`gateway_resources`에 nullable 두 칼럼을 더한다.

```
local_discovery_opted_in_at   TEXT        언제
local_discovery_opted_in_by   TEXT        누가 (users.id)
```

- 로컬로 확인됐고 아직 옵인 전이면 **"이 머신의 Hermes 프로필 읽기"** 버튼을 노출
- **소유자만** 옵인 가능 (`isOwner`)
- 옵인 이전에는 어떤 파일도 열지 않는다

언제·누가를 남기는 이유는 나중에 "앱이 왜 내 토큰을 갖고 있는가"에 답하기
위해서다. 값이 아니라 **동의 사실**을 기록한다.

## 6. 발견

옵인된 로컬 게이트웨이에 대해:

```
프로필 후보   <루트>/profiles/<이름>/ 중 config.yaml 이 있는 것
토큰         <그 디렉토리>/.env 의 API_SERVER_KEY (16자 이상)
             단 default 프로필은 <루트>/.env
제외         이미 이 게이트웨이에 등록된 이름
             PROFILE_NAME_RE 를 통과하지 못하는 이름
             (src/app/api/gateways/[id]/profiles/validation.ts:8)
교차 검증     각 후보를 /p/<이름>/health 로 확인해 200인 것만 "사용 가능"
```

### 6.1 두 출처를 겹치는 이유

파일시스템은 "이름과 토큰이 있다"만 알려주고, 게이트웨이는 "실제로 서빙 중이다"를
알려준다. 각자 상대의 약점을 덮는다.

실측 근거: `~/.hermes/profiles/` 에는 `acestep_output` 처럼 에이전트가 아닌
디렉토리도 프로필과 같은 레이아웃(config.yaml + .env + SOUL.md)을 갖고 있다.
파일시스템만 믿으면 이것을 프로필로 제시하게 된다.

### 6.2 default 프로필의 예외

실측: `~/.hermes/profiles/default/` 에는 `config.yaml`은 있으나 `.env`가 **없다**.
default 프로필의 홈은 `~/.hermes/` 자체이므로 토큰은 `<루트>/.env`에서 읽는다.
이 예외를 놓치면 default만 조용히 "토큰 없음"으로 표시된다.

### 6.3 화면

체크박스 목록에 프로필당 한 행:

```
[ ] sophie     토큰 있음   게이트웨이 응답 O
[ ] danvi      토큰 있음   게이트웨이 응답 O
[ ] ada        토큰 없음   게이트웨이 응답 O      ← 선택 불가, 사유 표시
[✓] noah       이미 등록됨                        ← 비활성
```

**토큰 값은 어떤 경우에도 표시하지 않는다.** 유무만 보여준다.

선택 후 한 번의 저장으로 `hermes_profiles` 행들을 만든다. 기존 등록 API의 검증을 그대로 통과시킨다 —
`validateProfileRegistration`(이름 규칙 + 토큰 16자 이상, 같은 파일)과
`hermes_profiles_gateway_name_idx` 유니크 제약.

## 7. 원격 검증

프로필 이름 입력란에 디바운스를 걸고 `/p/<이름>/health`를 찌른다.

| 응답 | 표시 |
|---|---|
| 200 | 확인됨 |
| 404 | 이 게이트웨이에 없는 프로필 |
| 무응답·타임아웃 | 확인 불가 |

**제출을 막지 않는다.** 게이트웨이가 일시적으로 죽어 있을 때 등록 자체가
불가능해지면 안 된다 — 실제로 겪은 상황이다(감시자가 하트비트 지연으로
게이트웨이를 30~60초마다 재시작하던 구간).

기존 `probeHermesGateway`(`src/lib/hermes/gateway-probe.ts`)를 프로필 경로까지
받도록 확장해 재사용한다.

## 8. 보안 규칙

- 토큰은 **서버에서만** 읽는다. 클라이언트로 내려보내지 않는다
  (기존 게이트웨이 토큰과 동일한 write-only 규칙)
- 옵인 없이는 파일을 열지 않는다
- 소유자만 옵인할 수 있다
- 발견 응답에는 토큰 값이 포함되지 않는다 — 유무 불리언만
- 저장 시 기존 경로와 같이 암호화해 넣는다 (`v1:iv:tag:암호문`)

## 9. 범위 밖

| 항목 | 사유 |
|---|---|
| 프로필 생성·편집 | 셸 호출 인자 인젝션 방어가 필수 비용이고, 원격에서 동작하지 않아 기능이 반쪽이 된다 |
| @멘션 피어 대화 | `ConversationEngine`(P2) 위에 올리는 별도 스펙 |
| `profiles.*` RPC | 2.2 — 외부 서버용 인증 경로 없음 |
| 게이트웨이 레벨 토큰 정리 | Hermes에서는 사실상 미사용(인증이 프로필별)이나, 제거는 OpenClaw 어댑터 제거와 함께 간다 |

## 10. 완료 기준

1. 로컬 게이트웨이에서 옵인 후 프로필 목록이 뜨고, 체크 후 한 번의 저장으로
   등록된다. 토큰을 한 번도 입력하지 않는다.
2. `acestep_output` 같은 비에이전트 디렉토리는 "게이트웨이 응답 없음"으로
   구분되어 선택되지 않는다.
3. `default` 프로필이 `<루트>/.env`에서 토큰을 찾아 "토큰 있음"으로 나온다.
4. 컨테이너(또는 프로필 루트가 없는 환경)에서는 옵인 버튼이 나타나지 않고,
   원격 검증만 동작한다.
5. 원격 게이트웨이에서 이름을 치면 200/404/무응답이 구분되어 표시되고,
   무응답이어도 저장은 가능하다.
6. 옵인하지 않은 게이트웨이에서는 서버가 파일시스템을 건드리지 않는다
   (테스트로 고정).
7. 어떤 API 응답에도 프로필 토큰 값이 포함되지 않는다 (테스트로 고정).
