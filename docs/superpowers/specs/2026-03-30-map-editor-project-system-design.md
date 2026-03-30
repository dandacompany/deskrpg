# Map Editor Project System Design

## Overview

맵 에디터에 '프로젝트' 개념을 도입하여, 세션 간 데이터 영속성을 확보한다. 현재 세션 내에서만 유지되는 타일셋/맵 설정을 DB에 저장하고, 프로젝트 단위로 불러오기/저장/관리할 수 있도록 한다.

## Requirements

- **1 프로젝트 = 1 맵** + 해당 맵에 사용된 타일셋/스탬프 연결 정보
- **타일셋/스탬프는 글로벌 공유** — 프로젝트 간 재사용 가능, 마켓플레이스 스타일 import
- **빌트인 에셋** — 시스템 제공 타일셋/스탬프를 라이브러리에서 import
- **DB 중심 저장** — 모든 데이터(메타, 맵 JSON, 이미지 base64)를 DB에 저장. 파일 시스템 의존 제거
- **프로젝트 브라우저** — 첫 진입 시 프로젝트 선택 화면, File 메뉴로도 접근 가능
- **기존 데이터 무시** — 깨끗한 시작, 레거시 mapTemplates 데이터 마이그레이션 불필요

## Architecture

### DB Schema

#### 새 테이블: `projects`

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid (PG) / text (SQLite) | PK |
| name | varchar(255) | 프로젝트 이름 |
| thumbnail | text (nullable) | 맵 썸네일 base64 |
| tiledJson | jsonb (PG) / text (SQLite) | Tiled 맵 전체 구조 |
| settings | jsonb (PG) / text (SQLite) | 프로젝트 설정 (tileSize, spawnPoint 등) |
| createdAt | timestamp | 생성일 |
| updatedAt | timestamp | 수정일 |

#### 새 테이블: `project_tilesets`

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid / text | PK |
| projectId | uuid / text | FK → projects.id |
| tilesetId | uuid / text | FK → tileset_images.id |
| firstgid | integer | 이 프로젝트에서의 GID 오프셋 |
| addedAt | timestamp | 연결 시점 |

Unique constraint: `(projectId, tilesetId)`

#### 새 테이블: `project_stamps`

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid / text | PK |
| projectId | uuid / text | FK → projects.id |
| stampId | uuid / text | FK → stamps.id |
| addedAt | timestamp | 연결 시점 |

Unique constraint: `(projectId, stampId)`

#### 기존 테이블 수정: `tileset_images`

추가 컬럼:
- `builtIn` (boolean, default false) — 빌트인 타일셋 여부
- `tags` (text, nullable) — 검색/분류용 태그 (JSON array)

#### 기존 테이블 수정: `stamps`

추가 컬럼:
- `builtIn` (boolean, default false) — 빌트인 스탬프 여부
- `tags` (text, nullable) — 검색/분류용 태그 (JSON array)

### API Endpoints

#### 프로젝트 CRUD

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/projects` | 프로젝트 목록 (tiledJson 제외, 메타+썸네일만) |
| POST | `/api/projects` | 새 프로젝트 생성 |
| GET | `/api/projects/[id]` | 프로젝트 상세 (tiledJson + 연결된 tilesets + stamps) |
| PUT | `/api/projects/[id]` | 프로젝트 저장 |
| DELETE | `/api/projects/[id]` | 프로젝트 삭제 (연결 테이블도 CASCADE) |
| POST | `/api/projects/[id]/duplicate` | 프로젝트 복제 |

#### 프로젝트-에셋 연결

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/projects/[id]/tilesets` | 프로젝트에 타일셋 연결 |
| DELETE | `/api/projects/[id]/tilesets/[tilesetId]` | 프로젝트에서 타일셋 제거 |
| POST | `/api/projects/[id]/stamps` | 프로젝트에 스탬프 연결 |
| DELETE | `/api/projects/[id]/stamps/[stampId]` | 프로젝트에서 스탬프 제거 |

#### 기존 API 수정

- `GET /api/tilesets` — `builtIn` 쿼리 파라미터 추가 (true/false/all)
- `GET /api/stamps` — `builtIn` 쿼리 파라미터 추가 (true/false/all)

#### 삭제 예정

- `POST /api/map-templates/upload` — ZIP 업로드 방식 제거

### Component Structure

#### 새 컴포넌트

| 컴포넌트 | 파일 | 역할 |
|---------|------|------|
| ProjectBrowser | `src/components/map-editor/ProjectBrowser.tsx` | 프로젝트 목록, 검색, 정렬, 카드 그리드, 생성/복제/삭제 |
| NewProjectModal | `src/components/map-editor/NewProjectModal.tsx` | 새 프로젝트 생성 모달 (이름, 맵 크기, 타일 크기) |

#### 새 훅

| 훅 | 파일 | 역할 |
|----|------|------|
| useProjectManager | `src/components/map-editor/hooks/useProjectManager.ts` | loadProject, saveProject, createProject, duplicateProject — MapEditorLayout에서 분리 |

#### 수정 컴포넌트

| 컴포넌트 | 변경 |
|---------|------|
| MapEditorLayout.tsx | 프로젝트 미선택 시 ProjectBrowser 표시. loadTemplate → loadProject, handleSaveToDeskRPG → saveProject. 프로젝트 로드/저장 로직을 useProjectManager로 이동 |
| Toolbar.tsx | File 메뉴: New Map → New Project, Open → Open Project, Save (DB 직접), Save As 추가 |
| ImportTilesetModal.tsx | 3탭 구조: 파일 업로드 / 내 타일셋 / 빌트인 |
| StampPanel.tsx | 3탭 구조: 프로젝트 / 내 스탬프 / 빌트인 |
| useMapEditor.ts | projectId 상태 추가 |

#### 삭제/대체

- `NewMapModal.tsx` → `NewProjectModal.tsx`로 대체
- `buildProjectZip` 관련 로직 제거 (MapEditorLayout 내)

## Data Flow

### 프로젝트 생성

```
NewProjectModal (이름, 크기, 타일크기)
  → POST /api/projects { name, settings: { cols, rows, tileWidth, tileHeight } }
  → DB INSERT (빈 tiledJson: Floor 레이어 1개)
  → 응답의 project.id로 맵 에디터 진입
  → dispatch('SET_MAP', { mapData, projectId })
```

### 프로젝트 로드

```
ProjectBrowser → 카드 클릭
  → GET /api/projects/{id}
  → 응답: { project, tilesets: [...], stamps: [...] }
  → 각 tileset.image (base64) → HTMLImage 변환 → tilesetImages 캐시
  → dispatch('SET_MAP', { mapData: project.tiledJson, projectId: project.id })
  → StampPanel에 stamps 표시
```

### 프로젝트 저장 (⌘S)

```
Save 클릭 또는 ⌘S
  → PUT /api/projects/{id} {
      tiledJson: state.mapData,
      thumbnail: canvasToBase64(),
      settings: { ... }
    }
  → 새로 추가된 타일셋: POST /api/tilesets (upsert) + POST /api/projects/{id}/tilesets
  → dispatch('MARK_CLEAN')
```

### 타일셋 Import (라이브러리에서)

```
ImportTilesetModal → "내 타일셋" 또는 "빌트인" 탭
  → 타일셋 카드 클릭
  → POST /api/projects/{projectId}/tilesets { tilesetId, firstgid }
  → dispatch('ADD_TILESET', { ... })
  → tilesetImages 캐시에 HTMLImage 추가
```

### 타일셋 Import (파일 업로드)

```
ImportTilesetModal → "파일 업로드" 탭
  → 로컬 PNG 선택 → 그리드 설정
  → POST /api/tilesets { name, image (base64), ... }  (DB 저장)
  → POST /api/projects/{projectId}/tilesets { tilesetId, firstgid }  (프로젝트 연결)
  → dispatch('ADD_TILESET', { ... })
```

### 스탬프 저장

```
맵에서 선택 → "스탬프로 저장"
  → POST /api/stamps { name, layers, tilesets, thumbnail }
  → POST /api/projects/{projectId}/stamps { stampId }  (프로젝트에 자동 연결)
  → StampPanel "프로젝트" 탭에 표시
```

## User Flow

### 첫 진입

```
/map-editor 접속
  → ProjectBrowser 표시
  → 프로젝트 없음: "새 프로젝트를 만들어보세요" + 버튼
  → 프로젝트 있음: 카드 그리드 (썸네일, 이름, 수정일)
```

### 프로젝트 브라우저 기능

- **검색**: 이름으로 필터링
- **정렬**: 이름순 / 최근 수정순 / 생성일순
- **썸네일**: 맵 미리보기 (projects.thumbnail)
- **복제**: 카드 hover → 복제 버튼 → POST /api/projects/{id}/duplicate
- **삭제**: 카드 hover → 삭제 버튼 → 확인 모달 → DELETE /api/projects/{id}

### File 메뉴 (맵 에디터 내)

```
File
├── New Project        (⌘N)   → 프로젝트 브라우저 (새로 만들기 포커스)
├── Open Project       (⌘O)   → 프로젝트 브라우저
├── Save               (⌘S)   → DB에 직접 UPDATE
├── Save As                    → 이름 입력 → 새 프로젝트로 복제 저장
├── ─────────────────
├── Export submenu
│   ├── Export as TMJ          → 로컬 다운로드 (기존 유지)
│   ├── Export as TMX          → 로컬 다운로드 (기존 유지)
│   └── Export as PNG          → 로컬 다운로드 (기존 유지)
├── ─────────────────
└── Back to DeskRPG
```

## Import Tileset Modal — 3탭 구조

### 탭 1: 파일 업로드

기존 ImportTilesetModal 기능 유지. 추가로:
- 업로드한 이미지를 `tileset_images` 테이블에 자동 저장
- 프로젝트에 자동 연결 (`project_tilesets` INSERT)

### 탭 2: 내 타일셋

- `GET /api/tilesets?builtIn=false` — 사용자가 업로드한 타일셋 목록
- 썸네일(이미지 축소) + 이름 + 타일 크기 표시
- 클릭 → 프로젝트에 연결

### 탭 3: 빌트인

- `GET /api/tilesets?builtIn=true` — 시스템 제공 타일셋
- 동일한 UI, 클릭 → 프로젝트에 연결

## Stamp Panel — 3탭 구조

### 탭 1: 프로젝트

- 현재 프로젝트에 연결된 스탬프만 (`project_stamps` JOIN `stamps`)
- 기존 StampPanel 기능 유지 (격자/목록 뷰, 검색, 편집, 배치)

### 탭 2: 내 스탬프

- `GET /api/stamps?builtIn=false` — 사용자가 만든 모든 스탬프
- 클릭 → 프로젝트에 추가 (project_stamps INSERT)
- 추가 후 "프로젝트" 탭으로 자동 이동

### 탭 3: 빌트인

- `GET /api/stamps?builtIn=true` — 시스템 제공 스탬프
- 클릭 → 프로젝트에 추가

## Key Decisions

1. **ZIP 패키징 제거** — 저장 시 DB 직접 UPDATE. 파일 시스템 의존성 완전 제거.
2. **프로젝트-에셋 연결 테이블** — N:M 관계로 에셋 재사용 지원. firstgid는 프로젝트별 매핑.
3. **builtIn 플래그** — 빌트인 에셋을 별도 테이블이 아닌 플래그로 구분. 쿼리 단순화.
4. **useProjectManager 훅 분리** — MapEditorLayout.tsx(1540줄)의 프로젝트 관련 로직을 별도 훅으로 추출하여 파일 크기 관리.
5. **자동 저장 미포함** — 1차 구현 범위에서 제외. 추후 별도 이터레이션.
6. **기존 mapTemplates 유지** — 게임 맵 연결용으로 남겨둠. 프로젝트 시스템과 별개.
