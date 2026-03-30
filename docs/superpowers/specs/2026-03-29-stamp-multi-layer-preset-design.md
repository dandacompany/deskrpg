# Stamp (Multi-Layer Preset) Design

## Goal

맵 에디터에서 여러 레이어에 걸친 타일 배치를 하나의 단위(Stamp)로 저장하고, 다른 위치나 맵에 원클릭으로 재사용할 수 있는 시스템을 구현한다.

## Architecture

풀 스택 구현: PostgreSQL DB 테이블 → Next.js API 라우트 → 좌측 패널 Stamps 섹션 UI. Stamp는 자기 완결적(self-contained)으로 타일셋 이미지 에셋을 포함하여 어떤 맵에서든 즉시 사용 가능하다.

## Tech Stack

- DB: PostgreSQL + Drizzle ORM (기존 인프라)
- API: Next.js API Routes
- UI: React 18 + TypeScript + Tailwind CSS + Lucide Icons
- State: useReducer (기존 useMapEditor 패턴 확장)

---

## 1. Data Model

### 1.1 `stamps` DB Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | 자동 생성 |
| `name` | varchar(200) | Stamp 이름 ("의자", "책상+의자 세트" 등) |
| `cols` | integer | Stamp 너비 (타일 단위) |
| `rows` | integer | Stamp 높이 (타일 단위) |
| `tile_width` | integer | 타일 픽셀 너비 (보통 32) |
| `tile_height` | integer | 타일 픽셀 높이 (보통 32) |
| `layers` | jsonb | 레이어별 타일 데이터 |
| `tilesets` | jsonb | 사용된 타일셋 메타 + 이미지 data URL |
| `thumbnail` | text | 미리보기 이미지 (base64 data URL) |
| `created_by` | uuid FK → users | nullable (에디터 단독 사용 시 null) |
| `created_at` | timestamp | 자동 |

### 1.2 `layers` jsonb Structure

```json
[
  {
    "name": "Walls",
    "type": "tilelayer",
    "depth": 1,
    "data": [0, 0, 5, 5, 0, 0]
  },
  {
    "name": "Foreground",
    "type": "tilelayer",
    "depth": 10000,
    "data": [8, 8, 0, 0, 9, 9]
  }
]
```

- `data`: 1D row-major 배열, 크기 = cols × rows
- GID는 Stamp 내부 기준 (firstgid=1부터 시작). 배치 시 대상 맵의 GID로 리매핑됨
- 레이어 종류에 제한 없음 — Floor, Walls, Foreground, Collision 등 어떤 조합이든 가능

### 1.3 `tilesets` jsonb Structure

```json
[
  {
    "name": "office-tileset",
    "firstgid": 1,
    "tilewidth": 32,
    "tileheight": 32,
    "columns": 10,
    "tilecount": 100,
    "image": "data:image/png;base64,..."
  }
]
```

- Stamp에서 사용된 타일셋만 포함 (사용하지 않는 타일셋 제외)
- 이미지는 전체 타일셋 PNG를 base64 data URL로 저장

---

## 2. API

### 2.1 Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/stamps` | 목록 조회 (id, name, cols, rows, thumbnail, layers의 레이어 이름 목록만 반환. tilesets 제외하여 경량화) |
| `GET` | `/api/stamps/:id` | 상세 조회 (tilesets 포함, 배치 시 사용) |
| `POST` | `/api/stamps` | 새 Stamp 생성 |
| `DELETE` | `/api/stamps/:id` | Stamp 삭제 |

### 2.2 POST /api/stamps Request Body

```json
{
  "name": "의자 (정면)",
  "cols": 2,
  "rows": 3,
  "tileWidth": 32,
  "tileHeight": 32,
  "layers": [...],
  "tilesets": [...],
  "thumbnail": "data:image/png;base64,..."
}
```

### 2.3 GET /api/stamps Response (List)

```json
[
  {
    "id": "uuid",
    "name": "의자 (정면)",
    "cols": 2,
    "rows": 3,
    "thumbnail": "data:image/png;base64,...",
    "layerNames": ["Walls", "Foreground"]
  }
]
```

---

## 3. UI

### 3.1 Stamps Panel (좌측 패널 새 섹션)

기존 Layers / Tilesets / Minimap 아코디언과 동일한 패턴으로 **Stamps** 섹션 추가.

기본 섹션 순서: Layers → Tilesets → **Stamps** → Minimap

각 Stamp 아이템 표시:
- **썸네일** (40×40px): Stamp의 합성된 미리보기
- **이름**: 더블클릭으로 인라인 편집
- **레이어 배지**: 포함된 레이어 이름을 색상 태그로 표시 (Walls=파란, Foreground=노란, Collision=빨간 등, 기존 LAYER_COLORS 활용)
- **삭제 버튼**: hover 시 표시

빈 상태: "No stamps yet. Select a region on the map and right-click → Save as Stamp"

### 3.2 Stamp 생성 워크플로우

1. Select 도구로 맵 영역 선택
2. 우클릭 → 컨텍스트 메뉴에 **"Save as Stamp"** 항목 추가 (기존 Edit Pixels / Copy / Delete 메뉴 확장)
3. 이름 입력 다이얼로그 (간단한 텍스트 input + Save/Cancel)
4. 선택 영역의 **모든 visible tile layer** 데이터를 수집:
   - 각 레이어의 해당 영역 GID를 추출
   - 사용된 타일셋 정보 + 이미지를 번들링
   - 썸네일 생성 (모든 레이어를 합성 렌더링한 이미지, 기존 `renderSelectionToDataUrl` 활용)
5. POST /api/stamps로 DB에 저장
6. Stamps 패널 목록 갱신

### 3.3 Stamp 배치 워크플로우

1. Stamps 패널에서 Stamp 아이템 클릭 → **Stamp 모드** 진입
2. 커서에 Stamp의 **반투명 미리보기** 표시 (타일 그리드에 스냅)
3. 맵 클릭 → 해당 위치에 Stamp 배치 (반복 가능)
4. **Escape** 키로 Stamp 모드 종료

### 3.4 Stamp 모드 상태

- 기존 tool state와 별도로 `activeStamp: StampData | null` 상태 관리
- `activeStamp`이 설정되면 canvas에서 마우스 커서 위치에 반투명 미리보기 렌더링
- 클릭 시 배치 로직 실행
- Escape 또는 다른 tool 선택 시 `activeStamp = null`로 모드 종료

---

## 4. Placement Logic (배치 로직)

Stamp를 맵의 (targetX, targetY) 위치에 배치할 때의 처리 단계:

### Step 1: 타일셋 매칭 + 임포트

Stamp의 각 타일셋에 대해:
- 대상 맵에 **같은 이름**의 타일셋이 존재하면 → 해당 타일셋의 firstgid 사용
- 존재하지 않으면 → Stamp에 번들된 타일셋 이미지를 맵에 **자동 임포트** (새 firstgid 할당)

### Step 2: GID 리매핑 테이블 생성

Stamp 내부 GID → 대상 맵 GID 매핑 테이블 구축:
```
stampGid → localId = stampGid - stamp.tileset.firstgid
         → mapGid  = map.tileset.firstgid + localId
```

### Step 3: 레이어 매칭 + 자동 생성

Stamp의 각 레이어에 대해:
- 대상 맵에 **같은 이름** (case-insensitive)의 레이어가 있으면 → 해당 레이어에 배치
- 없으면 → Stamp 레이어의 name, type, depth 정보로 **새 레이어 자동 생성** 후 배치

### Step 4: 타일 배치

각 레이어에서 리매핑된 GID를 대상 위치에 배치:
```
for each (col, row) in stamp:
  stampGid = stamp.layers[layerName].data[row * stamp.cols + col]
  if stampGid === 0: skip  // 빈 셀은 기존 맵 데이터 유지
  mapGid = remapGid(stampGid)
  mapLayer.data[(targetY + row) * mapWidth + (targetX + col)] = mapGid
```

### Step 5: Undo 기록

모든 레이어의 변경 사항을 **하나의 Undo 단위**로 묶어 기록. Ctrl+Z로 전체 Stamp 배치를 한 번에 되돌리기 가능.

새 reducer action: `PLACE_STAMP` — 모든 레이어 변경 + 타일셋 임포트 + 레이어 생성을 하나의 액션으로 처리.

---

## 5. File Structure

### New Files
- `src/db/schema.ts` — stamps 테이블 추가
- `src/app/api/stamps/route.ts` — GET list, POST create
- `src/app/api/stamps/[id]/route.ts` — GET detail, DELETE
- `src/components/map-editor/StampPanel.tsx` — Stamps 패널 UI
- `src/components/map-editor/SaveStampModal.tsx` — 이름 입력 다이얼로그

### Modified Files
- `src/components/map-editor/hooks/useMapEditor.ts` — `PLACE_STAMP` action, `activeStamp` state, stamp 관련 타입 추가
- `src/components/map-editor/MapEditorLayout.tsx` — Stamps 섹션을 sectionOrder에 추가, stamp API 호출, activeStamp 상태 관리
- `src/components/map-editor/MapCanvas.tsx` — 컨텍스트 메뉴에 "Save as Stamp" 추가, stamp 미리보기 렌더링, 클릭 배치 처리
- `src/components/map-editor/hooks/useCanvasRenderer.ts` — stamp 미리보기 반투명 오버레이 렌더링

---

## 6. Scope Boundaries

### In Scope (v1)
- DB 테이블 + CRUD API
- 맵 선택 → Save as Stamp (우클릭 메뉴)
- Stamps 패널 (목록, 선택, 삭제)
- Stamp 배치 모드 (반투명 미리보기 + 클릭 배치)
- 자동 레이어 생성 + 타일셋 임포트 + GID 리매핑
- Undo/Redo 지원

### Out of Scope (future)
- 전용 Stamp 에디터 (처음부터 Stamp 구성)
- Stamp Export/Import (JSON 파일)
- Stamp 카테고리/태그 분류
- Stamp 회전/반전
- 유저 간 Stamp 공유 마켓플레이스
