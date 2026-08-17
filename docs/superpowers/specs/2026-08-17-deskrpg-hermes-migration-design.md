# DeskRPG — OpenClaw에서 Hermes Agent로 전환 설계

- 날짜: 2026-08-17
- 상태: 승인됨 (구현 계획 대기)
- 범위: 백엔드 전환 + 다자 대화 엔진 + 공간 기반 대화 참여

## 1. 목표

DeskRPG를 OpenClaw 전용에서 **Hermes Agent 전용**으로 전환한다. 동시에 지금 회의(meeting) 하나뿐인 다자 대화를 **peer / meeting / group 3모드를 갖는 단일 엔진**으로 일반화하고, 대화 참여 자격을 **맵 상의 물리적 위치**에 묶는다.

확정된 결정:

| # | 결정 | 근거 |
|---|---|---|
| D1 | OpenClaw를 완전 제거한다 (어댑터로도 남기지 않음) | 두 전송 방식을 모두 감당하는 추상화 비용 회피 |
| D2 | 전송은 Hermes API Server (HTTP + SSE), 프로필은 `/p/<profile>/` 프리픽스 | CLI 서브프로세스는 콜드스타트 + `/steer`·`/stop` 부재 |
| D3 | peer·meeting·group은 하나의 엔진의 3모드 | 턴·중단·트랜스크립트·할당량 로직 단일화 |
| D4 | 프로필은 동일 호스트면 자동 생성, 원격이면 바인딩만 | 프로필 CRUD는 CLI 전용이라 원격에서 불가 |
| D5 | 다자 대화는 사용자가 멘션으로 명시적으로 시작 | 비용 예측 가능성, 관전 보장 |
| D6 | NPC 이동의 목적지·도착 판정은 서버가 소유 | 현재는 트리거한 클라이언트만 알아서 브로커가 발언 순서를 통제할 수 없음 |
| D7 | 룸 입장 시 1회 이동 + 착석 유지 (발언마다 이동하지 않음) | 매 턴 이동 대기는 회의를 눈에 띄게 느리게 만듦 |
| D8 | 대화 영역은 맵 에디터에서 명시적으로 배치 | 조용한 폴백 없이 실패시켜 모호함 제거 |
| D9 | `meeting` 모드는 기존 동작을 회귀 없이 보존 | 이관 실패와 개선을 구분 가능하게 유지 |
| D10 | `peer` 모드는 손들기 폴링을 생략 | 2인 대화에서 폴링은 API 호출을 정확히 2배로 만드는 낭비 |

## 2. 근거가 된 실측

### 2.1 Hermes API Server가 OpenClaw WS RPC를 대체한다

`~/.hermes/hermes-agent/gateway/platforms/api_server.py` (7,601줄, Hermes v0.20.2 기준).

| 현재 OpenClaw RPC | Hermes 대응 |
|---|---|
| `chat.send` + `agent` delta 이벤트 | `POST /api/sessions/{id}/chat/stream` (SSE) 또는 `POST /v1/runs` + `GET /v1/runs/{id}/events` |
| `chat.abort` | `POST /v1/runs/{run_id}/stop` |
| `agents.list` | `GET /api/sessions`, `GET /v1/models` |
| 연결 테스트 | `GET /health/detailed`, `GET /v1/capabilities` |
| (없음) | `POST /v1/runs/{run_id}/steer` — 실행 중 지시 주입 |
| (없음) | `POST /api/sessions/{id}/fork` — 세션 분기 |

`api_server.py:7440-7441`이 **모든 라우트를 맨 경로와 `/p/{profile}` 프리픽스로 두 번 등록**한다. 프로필 스코핑이 미들웨어 하나로 전 API에 걸린다.

### 2.2 인증이 프로필별로 격리되고 fail-closed다

`api_server.py:1758-1815` (`_expected_api_key` / `_check_auth`). named 프로필은 자기 시크릿 스코프의 `API_SERVER_KEY`(16자 이상)를 가져야 하며 **기본 리스너의 키를 상속하지 않는다.** 없으면 401.

→ `gateway_resources`(baseUrl 1개 + token 1개) 모델로는 프로필 N개를 쓸 수 없다. `(baseUrl, profile, token)` 삼중항이 필요하다.

프로필별 시크릿 위치: `~/.hermes/profiles/<name>/.env` (프로필마다 자기 `.env`와 `config.yaml`을 가짐).

### 2.3 프로필 생성 API가 없다

API Server에는 세션·런·채팅만 있고 프로필 CRUD는 CLI 전용(`hermes profile create/delete/describe`). Bot Mode가 쓰던 `profiles.*` RPC는 **데스크톱 게이트웨이의 다른 표면**이라 여기서는 쓸 수 없다.

단, `_resolve_request_profile()`은 요청마다 `profiles_to_serve()`를 호출한다(`api_server.py:1988`). 디스크에 프로필이 생기면 게이트웨이 재시작 없이 즉시 `/p/<name>/`이 활성화된다 (`multiplex_profile_allowlist`가 설정된 경우 거기에도 이름 추가 필요).

### 2.4 Bot Mode 플러그인은 호출 가능한 표면이 아니다

Bot Mode는 Hermes **데스크톱 앱 안에서 도는 UI 플러그인**(`~/.hermes/desktop-plugins/`, `plugin.js` 단일 파일 5,736줄)이다. 서버 API가 아니라 앱 렌더러 코드라 DeskRPG 서버가 호출할 표면이 없다. A2A 구현도 셸 호출(`hermes -p <상대> chat -c "Bot Chat" ...`) + SOUL.md 프롬프트 주입이 전부이며, 전달이 호출 단위라 상대는 다음 실행 시점에 메시지를 본다 — 실시간 대화가 아니라 비동기 큐다.

→ "플러그인 활용"이 아니라 **같은 패턴을 DeskRPG 서버에 재구현**한다. DeskRPG의 브로커는 이미 Bot Mode보다 정교한 실시간 턴 제어를 하고 있으므로 이쪽이 우월하다.

### 2.5 현재 코드의 결합 지점

```
src/lib/openclaw-gateway.js      653줄  WS RPC 클라이언트 (삭제)
src/lib/gateway-resources.ts     512줄  자원/바인딩/암호화 (프로필 개념 추가)
src/lib/meeting-broker.js        500줄  gateway.chatSend/chatAbort 직접 호출 (재작성)
src/server/socket-handlers.ts  1,803줄  getOrConnectGateway + executeWithGateway 분기
src/lib/adapters/*                      NpcAdapter 추상화 이미 존재
```

`MeetingBroker`가 어댑터가 아니라 게이트웨이를 직접 잡고 있다(`meeting-broker.js:42`). 이 때문에 CLI 어댑터 NPC는 회의에 참가할 수 없다(`socket-handlers.ts:719`에서 openclaw가 아니면 거절). `config.adapterResolver`가 생성자에 들어와 있으나(`meeting-broker.js:44`) 사용되지 않는다 — 같은 방향의 미완성 리팩터 흔적.

### 2.6 회의실이 정적이고 맵과 무관하다

`meeting-discussion.ts:150`의 `getMeetingRoomId()`가 `meeting-${channelId}`를 반환한다. 채널당 회의 1개 고정이고, `meetingRooms`는 `Map<channelId, {participants, messages}>`로 맵 좌표가 없다.

### 2.7 이동 인프라는 있으나 권한이 클라이언트에 있다

`GameScene.ts:1254-1360`에 `npc:start-move`, `npc:call-to-player`, `npc:deliver-response`, `npc:start-return`이 A* 경로탐색(`findPath`)·보행 검증·`homeCol/homeRow` 복귀까지 구현되어 있다.

그러나 `GamePageClient.tsx:644` 주석: *"Only the caller runs local A\* pathfinding; other clients follow npc:position-sync"*. 서버(`socket-handlers.ts:1343`)는 좌표를 중계만 하고 NPC 위치를 모른다.

→ 트리거한 클라이언트가 이탈하면 NPC가 전원에게 얼어붙고, 나중에 접속한 관전자는 DB home 좌표에서 본다. 서버 브로커가 "대화 영역 도착 여부"를 판정할 수 없다.

### 2.8 Buzz 대조 (위키 근거)

- `[[buzz-아키텍처-조사-요약]]` — "Agents are members, not bots". 에이전트 추가 방법이 사람 추가 방법과 같다. 에이전트 간 대화는 `owner-only`가 **기본 차단**.
- `[[deskrpg-buzz-실제-에이전트-회의-설계]]` — 멀티 멘션 시 각 에이전트가 **독립 병렬 실행**되며, **Buzz 자체는 발언 순서를 보장하지 않는다.** 같은 에이전트·같은 채널은 한 턴만 in-flight이고 새 이벤트는 **steer 또는 queue**.

채택: 멘션 라우팅, steer/queue 의미론, 두 겹 타임아웃, owner 제어 우선, fail-closed.
비채택: Buzz의 실행 모델(순서 미보장). DeskRPG는 브로커가 lease를 발급해 순서를 보장한다.

## 3. 설계

### 3.1 자원·데이터 모델

```
[현재]                                  [변경 후]

channel ──1:1──► gateway_resource       channel ──1:1──► gateway_resource
                 (baseUrl, token,                        (baseUrl)   "채널 기본 게이트웨이"
                  pairedDeviceId)                             │ 1:N
                                                              ▼
npc.openclaw_config                                     hermes_profile
  { agentId, sessionKeyPrefix }                         (profileName, tokenEncrypted)
        │                                                     ▲ N:1
        └─► gateway.chatSend(agentId, …)                npc.hermes_profile_id
                                                              └─► POST /p/{profileName}/v1/runs
```

**`gateway_resources`** — 유지, 의미 변경.
- `baseUrl` = Hermes API Server 루트 (`http://minipc:8642`)
- `tokenEncrypted` → default 프로필용 키로 격하 (nullable)
- `pairedDeviceId` **삭제**. OpenClaw ed25519 디바이스 페어링 개념 전체 제거 — `generateDeviceIdentity`/`buildModernDeviceAuth`, `~/.deskrpg/openclaw-devices/`, `PAIRING_REQUIRED` 에러 경로, `OpenClawPairingStatusCard.tsx`

**`hermes_profiles`** — 신규.

| 컬럼 | 용도 |
|---|---|
| `gateway_id` FK | 소속 게이트웨이 |
| `profile_name` | `/p/<여기>/`. `(gateway_id, profile_name)` unique |
| `token_encrypted` | 프로필 스코프 `API_SERVER_KEY`. 기존 AES-256-GCM 헬퍼 재사용 |
| `display_name`, `description` | `hermes profile describe` 값 캐시 |
| `last_validated_at` / `last_validation_status` / `last_validation_error` | `/p/<name>/health/detailed` 결과 |
| `provisioned_by_deskrpg` | 자동 생성분 여부 (삭제 시 정리 판단) |

**`npcs`**
- `openclaw_config` → `agent_config` (`{ sessionKeyPrefix, model?, toolsets? }`, `agentId` 제거)
- `hermes_profile_id` FK 신규 (nullable — CLI 어댑터 NPC는 없음)
- `adapter_type` default `"openclaw"` → `"hermes"`

**`channel_gateway_bindings`** — 유지하되 역할 격하. "채널 기본 게이트웨이"로서 NPC 고용 시 프로필 목록 출처 + 채널 생성 RBAC 검증에만 사용. NPC의 실제 접속처는 `hermes_profile_id`가 단독 결정 → 한 채널에 서로 다른 게이트웨이의 프로필이 섞일 수 있다.

**`conversation_rooms`** — 신규. `(id, channel_id, mode, zone_rect, status, created_by, created_at)`
**`conversation_room_members`** — 신규. `(room_id, member_type: 'user'|'npc', member_id, seat_col, seat_row, seated, joined_at)`

**`meeting_minutes`** — `room_id` FK를 **추가**한다(`channel_id`는 유지). 기존 회의록은 `room_id = NULL`로 남고, 조회는 `room_id ?? channel_id`로 폴백한다. 채널마다 레거시 룸을 만들어 backfill하지 않는다 — 존재하지 않았던 물리적 영역을 소급해 지어내는 셈이고, 그 룸은 `zone_rect`가 없어 어차피 반쪽이다. 신규 회의록만 `room_id`를 갖는다.

`gateway_shares`는 손대지 않는다. 공유 단위가 여전히 게이트웨이이고 프로필은 그 하위다. 프로필 단위 allowlist는 YAGNI로 보류.

**마이그레이션 정책**: `agentId`와 프로필 이름 사이에 신뢰할 대응이 없으므로 자동 변환하지 않는다. 기존 NPC는 `hermes_profile_id = NULL`, `adapter_type = 'unbound'`로 표시하고 게임에서 "재연결 필요"로 렌더링한다. 회의록·태스크·좌표·외형은 보존된다.

SQLite는 세 곳을 함께 수정한다: `schema-sqlite.ts`, `sqlite-base-schema.js`(빈 DB 부트스트랩), `ensureSqliteCompatibility()`(기존 DB 승격). 빈 DB로 `deskrpg init/start`와 Docker SQLite 기동을 재검증한다.

### 3.2 룸 모델과 공간 기반 참여

```
@멘션 1명         → DM 세션 (룸 없음). NPC가 플레이어에게 이동 = npc:call-to-player 재사용
@멘션 2명 이상    → conversation_room 동적 생성
                    ├ 맵의 빈 대화 영역(zone) 할당·점유
                    ├ 멘션된 NPC에게 좌석 이동 지시
                    └ 전원 착석 후 ConversationEngine 시작
플레이어 영역 진입 → 해당 룸 채팅 UI에 참여자로 합류
```

영역은 `channels.mapData`의 전용 레이어에서 온다(맵 에디터에 "대화 영역" 스탬프 추가). 룸 생성 시 비어 있는 영역 하나를 잠근다. **영역이 없으면 그룹 대화 생성이 실패한다** — 조용한 폴백을 만들지 않고 "회의 영역을 먼저 배치하세요"로 안내한다.

멘션 파싱은 NPC 이름이 아니라 **프로필 이름 기준**이다. 채널 내 NPC 이름은 중복될 수 있으나 프로필은 `(gateway, profileName)`으로 유일하다.

`npcs_channel_position_unique(channelId, positionX, positionY)` 제약과 충돌하지 않는다. 해당 컬럼은 NPC의 **home 좌표**이고 이동 중 위치는 DB에 쓰지 않는다(`homeCol/homeRow`로 복귀). 룸 좌석은 `conversation_room_members.seat_*`에 별도 저장한다.

### 3.3 이동 권한

| 소유 | 주체 |
|---|---|
| 목적지 결정 (어느 좌석) | **서버** |
| 도착 판정 (발언 자격) | **서버** |
| 경로 계산·애니메이션 보간 | 클라이언트 (현행 유지) |
| 좌표 중계 | 서버 (현행 유지) |

서버는 목적지 좌석과 예상 소요시간 타이머를 갖고, 클라의 `arrived` ack **또는** 타이머 만료 중 먼저 오는 쪽으로 도착을 확정한다. 트리거한 클라가 이탈해도 타이머가 회의를 진행시킨다. 서버가 새로 알아야 하는 것은 목적지 셀의 보행 가능 여부뿐이며 `channels.mapData`가 이미 서버에 있다.

### 3.4 HermesAdapter

**SSE 이벤트 어휘** (`api_server.py:3885-4011`). 모든 이벤트에 `run_id`와 `seq`가 자동 부착된다(`payload.setdefault`).

```
run.started ─► message.started ─┬─► assistant.delta   (텍스트 청크)
                                ├─► tool.progress
                                └─► tool.started / tool.completed / tool.failed
              ─► assistant.completed ─► run.completed | run.cancelled | run.failed | error ─► done
```

`run_id`가 이벤트에 실려 오므로 1:1 세션 채팅도 `/v1/runs/{run_id}/stop`으로 중단 가능하다 — 두 경로가 같은 제어 표면을 쓴다. `seq`는 재연결 시 유실 감지에, `tool.*`는 NPC 말풍선의 진행 표시에 쓴다(OpenClaw 경로에 없던 정보).

**인터페이스 변경** — `types.ts:14-17`의 OpenClaw 전용 필드를 제거한다.

```ts
interface AdapterExecuteOptions {
  sessionKey: string;
  prompt: string;
  conversationHistory?: Array<{ role: string; content: string }>;  // 신규 — 다자용
  onDelta?: (chunk: string) => void;
  onToolProgress?: (toolName: string, preview: string) => void;    // 신규
  onRunStarted?: (runId: string) => void;                          // 신규 — 중단 핸들
  attachments?: AdapterAttachment[];
  model?: string; locale?: string; timeoutMs?: number;
  userId?: string; projectId?: string;
  // agentId / channelId 삭제 — 프로필은 어댑터 생성 시점에 확정
}
```

`agentId`·`channelId` 제거로 `executeWithGateway`/`abortWithGateway` 쌍이 사라지고 `NpcAdapter` 인터페이스가 원래 의도대로 복원된다.

**두 호출 경로**

| 용도 | 엔드포인트 | 히스토리 소유 |
|---|---|---|
| 1:1 DM | `POST /p/{profile}/api/sessions/{id}/chat/stream` | Hermes 세션 |
| 다자 | `POST /p/{profile}/v1/runs` + `conversation_history` | DeskRPG 브로커 |
| 중단 | `POST /p/{profile}/v1/runs/{run_id}/stop` | 공통 |
| 개입 | `POST /p/{profile}/v1/runs/{run_id}/steer` | 공통 |

양쪽 모두 `X-Hermes-Session-Key` 헤더로 NPC의 장기 기억 스코프를 건다. DM은 세션 ID를 `npc_sessions.session_ref`에 저장해 재개한다.

**연결 검증**: `GET /p/{profile}/v1/capabilities`가 기능 맵을 반환한다(`api_server.py:3142-3196`). `run_steer`·`session_fork`·`session_chat_streaming` 플래그를 확인해 구버전에서는 해당 기능만 비활성화하고 나머지는 동작시킨다.

**규모 축소**: `openclaw-gateway.js` 653줄 → 약 200줄. 사라지는 것 — WebSocket 재연결 백오프, tick keepalive 감시, `_pending` 요청 맵, `_chatStreams` 맵, ed25519 디바이스 아이덴티티, protocol 1~3 협상, challenge 핸드셰이크. `socket-handlers.ts:158`의 `channelGateways` 연결 풀과 `invalidateGatewayConnectionForChannel`도 제거된다.

### 3.5 ConversationEngine

```
ConversationEngine
├─ participants: Participant[]   { npcId, adapter, seated, turnCount, lastSpokeAt }
├─ transcript: Turn[]            → conversation_history 로 직렬화
├─ mode: TurnPolicy              ← 교체 지점
└─ run(): while(!finished) { drainCommands → 사용자 메시지 → policy.nextSpeaker() → speak() }
```

| | **peer** (2인) | **meeting** (N인) | **group** (N인 자유) |
|---|---|---|---|
| 발언자 선정 | 교대 (A→B→A) | 손들기 폴링 후 최장 미발언자 | 손들기 폴링, 병렬 허용 |
| 폴링 | 없음 (D10) | 매 턴 전원 | 매 턴 전원 |
| 종료 | 턴 소진 / 사용자 종료 | 연속 PASS 2회 | 사용자 종료 |
| 사용자 개입 | 언제든 | 언제든 (`/steer`) | 언제든 |
| 회의록 | 없음 | `meeting_minutes` 저장 | 선택 |

`meeting`은 현재 브로커 동작을 그대로 보존한다 — `auto`/`manual`/`directed` 하위 모드, hybrid 자동 재개, 할당량(`maxTurnsPerAgent` 20 / `maxTotalTurns` 50) 포함 (D9).

**착석 게이트** — 실질 변경분은 `meeting-broker.js:286`의 필터 한 줄이다.

```ts
const agents = this.participants.filter(p =>
  this.getRemainingTurns(p.npcId) > 0 && p.seated
);
```

회의 중 새로 멘션된 NPC는 `seated = false`로 입장해 이동 완료 전까지 발언권 후보에서 제외된다.

**Buzz 유래 안전장치**

1. **두 겹 타임아웃** — idle(에이전트 활동 시 리셋)과 max turn(절대 상한)을 분리한다. 현재는 `turnTimeoutMs` 하나뿐이라 "긴 도구 작업"과 "멈춘 에이전트"를 구분하지 못한다. `tool.progress` 수신 시 idle 타이머를 리셋한다.
2. **owner 제어 우선** — 중단·전원 정지는 커맨드 큐를 건너뛴다. `stop()`이 이미 큐를 우회한다(`meeting-broker.js:196`).
3. **fail-closed** — 참가 자격 판정 실패 시 허용이 아니라 차단.

**폴링 청크 분할** — 현재 `Promise.allSettled`로 전원 동시 발사한다(`meeting-broker.js:297`). Hermes의 `gateway.api_server.max_concurrent_runs`를 `/v1/capabilities`에서 읽어 그 값으로 청크를 나눈다. 그렇지 않으면 큰 회의에서 뒤쪽 참가자가 429로 조용히 빠진다.

### 3.6 배포

**게이트웨이 설정 (운영자)**

```yaml
# ~/.hermes/config.yaml (default 프로필)
gateway:
  multiplex_profiles: true          # 없으면 /p/<profile>/ 이 무시된다
  platforms: [api_server]
  api_server:
    port: 8642
    max_concurrent_runs: 8
```

```bash
hermes profile create sophie
printf 'API_SERVER_KEY=%s\n' "$(openssl rand -hex 24)" >> ~/.hermes/profiles/sophie/.env
```

**Docker 자산**

| 삭제 | 신규 |
|---|---|
| `docker/Dockerfile.openclaw` | `docker/Dockerfile.hermes` |
| `docker/openclaw-entrypoint.sh` | `docker/hermes-entrypoint.sh` |
| `docker/docker-compose.openclaw.yml` | `docker/docker-compose.hermes.yml` |
| `.env.example`의 `OPENCLAW_*` 3개 | `HERMES_GATEWAY_URL`, `HERMES_PROFILES` |

`hermes-entrypoint.sh`는 `HERMES_PROFILES=sophie,danvi,sam`을 읽어 프로필을 생성하고, 각 `.env`에 랜덤 `API_SERVER_KEY`를 심고, `config.yaml`에 멀티플렉스·api_server를 설정한 뒤 `hermes gateway start`를 실행한다. 키는 볼륨에 영속되므로 재시작해도 유지된다.

**`Dockerfile:44` 수정 필수** — 현재 `COPY --from=builder /app/src/lib/openclaw-gateway.js`로 런타임 헬퍼를 명시 복사한다. 새 런타임 파일을 넣지 않으면 이미지가 부팅에 실패한다 (`CLAUDE.md`의 명시 규칙).

**스테이징** — `deskrpg-test-oc`(19010 → 18789)가 `deskrpg-test-hermes`(8642)로 대체된다. `npm run deploy:test`의 rsync·빌드 흐름은 유지. `CLAUDE.md`의 디바이스 페어링 승인 절차 문단은 삭제한다(Hermes는 Bearer 토큰이라 페어링 없음).

**롤아웃 순서**

1. 스키마 마이그레이션 + `adapter_type='unbound'` 표시
2. Hermes 게이트웨이 등록 → 프로필 목록 조회 → NPC 재바인딩 UI
3. 대화 영역 배치 (없으면 그룹 대화 비활성)
4. OpenClaw 자산 삭제

1~3이 끝날 때까지 4를 하지 않는다.

### 3.7 테스트

| 층 | 고정 대상 |
|---|---|
| `hermes-client.test.ts` | SSE 파싱 — `assistant.delta` 누적, `seq` 유실 감지, `run.failed`/`error` 구분, 중간 끊김 시 부분 응답 |
| `hermes-adapter.test.ts` | 두 경로 요청 형태, `/p/<profile>/` 프리픽스 조립, 401·404 매핑, capabilities 기반 기능 비활성화 |
| `conversation-engine.test.ts` | 3모드 정책, `seated=false` 참가자 제외, 폴링 청크 분할 |
| `conversation-room.test.ts` | 멘션 파싱, 룸 생성·영역 할당·점유 해제, 영역 부재 시 실패, 난입 처리 |
| `movement-authority.test.ts` | 도착 ack vs 타이머 경합, ack 없이 타이머만으로 진행, 트리거 클라 이탈 시 회의 지속 |
| `schema-drift.test.ts` (확장) | PG/SQLite 3파일 정합, 빈 DB 부트스트랩 |

**회귀 기준선을 먼저 만든다.** 이관 전에 현재 회의 동작(폴링→선정→발언→종료, 할당량, 모드 전환)을 OpenClaw 어댑터 목으로 통과시켜 두고, 이관 후 **동일 테스트가 Hermes 어댑터 목으로 통과**해야 한다. D9를 실행 가능한 형태로 고정하는 장치다.

기존 자산은 폐기하지 않고 이식한다: `phase1-integration.test.ts`(451줄), `phase2a-integration.test.ts`(317줄), `openclaw-adapter.test.ts`, `meeting-socket.test.ts`, `meeting-discussion.test.ts`.

E2E는 실제 게이트웨이가 필요하므로 로컬 `hermes gateway` 기반 수동 시나리오로 둔다 — 프로필 2개 그룹 대화 1회, 착석 이동 확인, `/steer` 개입 1회.

## 4. 범위 밖 (명시적 비목표)


- OpenClaw 데이터의 자동 변환 (§3.1 마이그레이션 정책)
- 맵 근접 기반 NPC 자동 잡담 (D5에서 배제)
- 프로필 단위 공유 allowlist (`gateway_shares` 확장) — 요구가 생기면 추가
- hermes-agent 업스트림 포크에 프로필 CRUD API 추가 (D4에서 배제)
- 전면 서버 권한 이동 (tick 기반 좌표 push) — D6의 목적지/도착 소유로 충분

## 5. 구현 단계 분해

이 스펙은 6개 서브시스템을 다루므로 단일 구현 계획으로는 크다. 아래 4단계로 나누고 **각 단계가 자기 구현 계획을 갖는다.** 각 단계 끝에서 앱이 동작 가능한 상태여야 한다.

| 단계 | 범위 | 완료 기준 |
|---|---|---|
| **P1 — 전송 교체** | `HermesClient` + `HermesAdapter`, `types.ts` 인터페이스 정리, 스키마(`hermes_profiles`, `npcs` 컬럼), 게이트웨이/프로필 등록 UI, 재바인딩 UI | 1:1 DM이 Hermes 프로필로 동작. 회의는 아직 기존 브로커가 새 어댑터를 경유해 동작 |
| **P2 — 엔진 일반화** | `MeetingBroker` → `ConversationEngine` 재작성, 3모드 정책, 폴링 청크 분할, 두 겹 타임아웃 | 회귀 기준선 테스트가 Hermes 어댑터 목으로 통과 (D9). `meeting` 모드 동작 불변 |
| **P3 — 공간과 룸** | `conversation_rooms`/`_members`, 멘션 라우팅, 대화 영역 스탬프, 이동 권한 서버 이전, 착석 게이트 | 멀티 멘션으로 룸 생성 → NPC 착석 → 그룹 대화 성립 |
| **P4 — 제거와 배포** | OpenClaw 자산 삭제, Docker 자산 교체, `.env.example`·README·`CLAUDE.md` 정리, 스테이징 전환 | `rg -i openclaw`가 코드베이스에서 0건. 스테이징 그린 |

P1~P3 동안 OpenClaw 코드는 남아 있지만 **경로에서 빠진 상태**(dead code)로 둔다. 되돌릴 지점을 유지하기 위해서이며, P4에서 한 번에 걷어낸다.

## 6. 미해결 사항

- `hermes profile create`의 셸 호출 경로·권한·인젝션 방어 구체안 (동일 호스트 모드에서만 활성)
- `multiplex_profile_allowlist`가 설정된 게이트웨이에서 신규 프로필 등록 시 config 편집 필요 — 자동화 여부
- 대화 영역 스탬프의 맵 에디터 UX (기존 스탬프 시스템 재사용 범위)
