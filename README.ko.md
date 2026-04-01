# DeskRPG

English README: [README.md](README.md)

<img src="public/readme/home-screenshot.png" alt="DeskRPG 홈 화면" width="100%" />

DeskRPG는 직접 운영할 수 있는 2D 픽셀 아트 가상 오피스입니다. LPC 기반 캐릭터를 만들고, 공유 채널에 입장해 실시간 오피스 맵을 돌아다니고, OpenClaw를 통해 AI NPC 동료를 고용하고, 업무를 맡기고, 오피스 안에서 직접 보고를 받고, 브라우저에서 AI 회의까지 진행할 수 있습니다.

DeskRPG는 평범한 채팅방 대신, 조금 더 살아 있는 업무 공간을 원하는 사람들을 위해 만들어졌습니다.

- 웹사이트: `https://deskrpg.com` (예정)
- 소스 코드: `https://github.com/dandacompany/deskrpg`
- 버전: `v0.2.2`

## 무엇을 할 수 있나요

- LPC 기반 캐릭터 커스터마이징으로 나만의 픽셀 오피스 아바타를 만들 수 있습니다.
- 실시간 멀티플레이가 가능한 오피스 채널에 입장하거나 직접 운영할 수 있습니다.
- AI NPC를 고용하고 OpenClaw 에이전트와 연결해 오피스 안에서 대화할 수 있습니다.
- NPC에게 업무를 맡기고, 보고를 요청하고, 중단된 업무를 재개시키고, 태스크 보드에서 진행 상황을 관리할 수 있습니다.
- 전용 회의실에서 AI 회의를 진행하고 회의록을 저장할 수 있습니다.
- 브라우저 기반 맵 에디터로 직접 오피스 맵을 만들거나 업로드할 수 있습니다.

## 스크린샷

<table width="100%">
  <tr>
    <td width="50%" valign="top"><img src="public/readme/deskrpg-login-to-office.gif" alt="DeskRPG 접속하기" width="100%" /></td>
    <td width="50%" valign="top"><img src="public/readme/deskrpg-npc-task-loop.gif" alt="DeskRPG NPC 채팅과 태스크" width="100%" /></td>
  </tr>
  <tr>
    <td width="50%" align="center"><strong>접속하기</strong></td>
    <td width="50%" align="center"><strong>NPC 채팅과 태스크</strong></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><img src="public/readme/deskrpg-meeting-room.gif" alt="DeskRPG 회의실" width="100%" /></td>
    <td width="50%" valign="top"><img src="public/readme/deskrpg-map-editor.gif" alt="DeskRPG 맵 에디터" width="100%" /></td>
  </tr>
  <tr>
    <td width="50%" align="center"><strong>회의실</strong></td>
    <td width="50%" align="center"><strong>맵 에디터</strong></td>
  </tr>
</table>

## 빠른 시작

아래 여섯 가지 방법 중 하나를 골라 DeskRPG를 시작할 수 있습니다.

### 1. npm 설치 런타임

레포를 클론하지 않고 설치형 앱처럼 바로 쓰고 싶다면 이 방식이 가장 간단합니다.

```bash
npx deskrpg init
npx deskrpg start
```

DeskRPG의 가변 런타임 데이터는 `~/.deskrpg/` 아래에 저장됩니다.

- `~/.deskrpg/.env.local`
- `~/.deskrpg/data/deskrpg.db`
- `~/.deskrpg/uploads/`
- `~/.deskrpg/logs/`

브라우저에서 `http://localhost:3000`을 엽니다.

퍼블리시된 npm 패키지 이름은 `deskrpg`입니다.

### 2. 로컬 실행 + PostgreSQL

```bash
git clone https://github.com/dandacompany/deskrpg.git
cd deskrpg
npm install
cp .env.example .env.local
npm run setup
npm run dev
```

브라우저에서 `http://localhost:3000`을 엽니다.

레포에서 전체 기능을 가장 직접적으로 확인하려면 이 방식이 가장 좋습니다.

### 3. 로컬 실행 + SQLite

```bash
git clone https://github.com/dandacompany/deskrpg.git
cd deskrpg
npm install
npm run setup:lite
npm run dev
```

SQLite 데이터는 `data/deskrpg.db`에 저장됩니다.

### 4. Docker + PostgreSQL

여러 사용자가 함께 쓰거나, 조금 더 안정적인 데이터 저장이 필요하면 이 구성을 권장합니다.

```bash
cp .env.example .env.docker
docker compose --env-file .env.docker up -d
```

처음 실행하기 전 `.env.docker`를 열어 아래 값을 설정하세요.

- `JWT_SECRET`
- `POSTGRES_PASSWORD`

DeskRPG는 `http://localhost:3102`에서 열립니다.

기본 이미지는 `dandacompany/deskrpg:latest`입니다.
특정 릴리스를 고정하고 싶다면 `.env.docker`의 `DESKRPG_IMAGE`를 `dandacompany/deskrpg:0.2.2`처럼 바꾸면 됩니다.

명시적으로 파일 경로를 지정하고 싶다면 아래 명령을 사용해도 됩니다.

```bash
docker compose --env-file .env.docker -f docker/docker-compose.external.yml up -d
```

### 5. Docker + PostgreSQL + OpenClaw

DeskRPG와 PostgreSQL, OpenClaw 게이트웨이를 한 번에 올리고 싶다면 이 구성을 사용하세요.

```bash
cp .env.example .env.docker
docker compose --env-file .env.docker -f docker/docker-compose.openclaw.yml up -d --build
```

처음 실행하기 전 `.env.docker`를 열어 아래 값을 설정하세요.

- `JWT_SECRET`
- `POSTGRES_PASSWORD`
- `OPENCLAW_TOKEN`

기본 포트:

- DeskRPG: `http://localhost:3102`
- OpenClaw: `http://localhost:18789/openclaw?token=<OPENCLAW_TOKEN>`

이 구성은 실제 기동 검증까지 끝난 상태입니다. 다만 OpenClaw는 컨테이너가 떠 있는 것만으로 바로 사용할 수 있는 게 아니라, 첫 실행 후 대시보드에서 provider/model 인증을 마쳐야 합니다.

1. `http://localhost:18789/openclaw?token=<OPENCLAW_TOKEN>`을 엽니다.
2. OpenClaw 대시보드에서 사용할 provider와 model을 인증하거나 선택합니다.
3. 그 다음 DeskRPG 안의 `설정 -> 채널 설정 -> AI 연결`에서 아래 값을 저장합니다.

- `OpenClaw 게이트웨이 URL`: `http://localhost:18789`
- `토큰`: `.env.docker`에 넣은 `OPENCLAW_TOKEN`

이 단계를 마치기 전에는 NPC 고용, 태스크 자동화, AI 회의가 동작하지 않습니다.

### 6. Docker + SQLite

한 대의 서버에서 가볍게 시작하고 싶다면 이 구성이 가장 간단합니다.

```bash
JWT_SECRET=change-me docker compose -f docker/docker-compose.lite.yml up -d
```

DeskRPG는 `http://localhost:3102`에서 열립니다.

특정 이미지 버전을 쓰고 싶다면 명령 앞에 `DESKRPG_IMAGE=dandacompany/deskrpg:0.2.2`을 붙이면 됩니다.

빠르게 시작하려면 SQLite, 오래 운영하려면 PostgreSQL을 선택하면 됩니다.

### 환경 변수

중요한 환경 변수:

- `JWT_SECRET`
- `POSTGRES_PASSWORD` (PostgreSQL Docker 구성 사용 시)
- `OPENCLAW_TOKEN` (OpenClaw 통합 Docker 구성 사용 시)

운영 환경에서는 반드시 실제 `JWT_SECRET` 값을 설정해야 합니다.

OpenClaw 게이트웨이 URL과 토큰은 앱 안의 `설정 -> 채널 설정 -> AI 연결`에서 입력합니다.
통합 Docker 구성을 사용하더라도, provider/model 인증은 OpenClaw 대시보드에서 직접 진행해야 합니다.

## OpenClaw 연결

AI NPC, 태스크 자동화, AI 회의는 OpenClaw 게이트웨이 연결이 필요합니다.

채널에 입장한 뒤:

1. 오른쪽 상단의 `설정` 메뉴를 엽니다.
2. `채널 설정`을 선택합니다.
3. `AI 연결` 탭으로 이동합니다.
4. 아래 두 값을 입력합니다.
   - `OpenClaw 게이트웨이 URL`
   - `토큰`
5. 저장하고 연결 테스트를 진행합니다.

연결이 끝나면 NPC를 고용하고, 사용 가능한 OpenClaw 에이전트와 연결할 수 있습니다.

## DeskRPG는 어떻게 동작하나요

### 1. 캐릭터

- 모든 사용자는 캐릭터로 채널에 입장합니다.
- 캐릭터 외형은 LPC 레이어 스프라이트를 조합해 구성됩니다.
- 채널에 들어가기 전에 캐릭터를 먼저 만들어야 합니다.

### 2. 채널

- 채널은 공유 오피스 공간입니다.
- 공개/비공개 여부와 그룹 규칙에 따라 접근 방식이 달라질 수 있습니다.
- 채널 맵은 맵 템플릿을 기반으로 생성됩니다.

### 3. AI NPC

- NPC는 채널 안에서 함께 생활합니다.
- NPC는 OpenClaw 에이전트와 연결할 수 있습니다.
- 앱 안의 메뉴에서 호출, 복귀, 대화, 수정, 대화 초기화, 해고가 가능합니다.

### 4. 태스크

- NPC와의 대화를 통해 업무를 맡길 수 있습니다.
- 태스크는 `대기`, `진행중`, `중단`, `완료` 상태를 오갑니다.
- 자동 재촉과 수동 보고 요청으로 NPC의 진행을 계속 밀어줄 수 있습니다.
- 중요한 보고는 NPC가 직접 플레이어에게 걸어와 전달합니다.

### 5. 회의

- DeskRPG에는 전용 회의실이 있습니다.
- AI 회의는 채널 단위로 동작하며 OpenClaw가 오케스트레이션합니다.
- 저장된 회의록은 헤더에서 바로 확인할 수 있습니다.

### 6. 맵 에디터

- 브라우저 기반 맵 에디터는 Tiled 스타일 워크플로를 지원합니다.
- 맵 템플릿 업로드, 프로젝트 연결 자산 관리, 채널용 맵 재사용이 가능합니다.
- 별도 부속 도구가 아니라 DeskRPG의 주요 서브시스템입니다.

## 제품 메모

- 초대 코드가 있어도 로그인은 필요합니다.
- 초대 코드는 채널 접근을 돕는 수단이지, 익명 접근 토큰은 아닙니다.
- 기본 오피스 타일과 오브젝트 텍스처는 런타임에 코드로 생성됩니다.
- LPC 아바타 스프라이트는 별도 크레딧과 라이선스 문서를 따릅니다.

## 라이선스와 크레딧

- 프로젝트 라이선스: [LICENSE.md](LICENSE.md)
- 서드파티 라이선스: [public/third-party-licenses.html](public/third-party-licenses.html)
- LPC 아바타 크레딧: [public/assets/spritesheets/CREDITS.md](public/assets/spritesheets/CREDITS.md)
- LPC 아바타 라이선스 안내: [public/assets/spritesheets/LICENSE-assets.md](public/assets/spritesheets/LICENSE-assets.md)
- LPC 전체 크레딧 데이터: [public/assets/spritesheets/CREDITS.csv](public/assets/spritesheets/CREDITS.csv)

## 문의

- YouTube: [@dante-labs](https://youtube.com/@dante-labs)
- 이메일: `dante@dante-labs.com`
- Buy Me a Coffee: `https://buymeacoffee.com/dante.labs`
