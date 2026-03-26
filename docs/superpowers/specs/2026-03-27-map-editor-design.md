# Map Editor & Template Management — Design Spec

**Date:** 2026-03-27
**Status:** Approved

## Overview

DeskRPG에 맵 에디터를 추가하여 사용자가 맵 템플릿을 생성, 수정, 삭제할 수 있도록 한다. 기존 하드코딩된 3개 템플릿(office, cafe, classroom)을 DB로 이전하고, RPG Maker 스타일의 타일맵 페인팅 에디터를 Phaser 3 기반으로 구현한다.

## Decisions

| 항목 | 결정 | 근거 |
|------|------|------|
| 위치 | 별도 페이지 `/map-editor` | 맵 제작과 채널 생성 분리, 기존 플로우 변경 최소화 |
| 저장소 | DB 완전 이전 (`map_templates` 테이블) | 단일 데이터 소스, 일관된 CRUD |
| 편집 방식 | 타일맵 페인팅 (RPG Maker 스타일) | 직관적, 빠른 맵 제작 |
| 렌더링 엔진 | Phaser 3 재사용 | WYSIWYG — 게임과 동일한 비주얼, 기존 에셋 재사용 |
| 맵 크기 | 자유 입력 (10×8 ~ 40×30) | 최대 유연성 |

## 1. DB Schema — `map_templates` Table

```sql
CREATE TABLE map_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(200) NOT NULL,
  icon          VARCHAR(10) NOT NULL DEFAULT '🗺️',
  description   VARCHAR(500),
  cols          INTEGER NOT NULL,
  rows          INTEGER NOT NULL,
  layers        JSONB NOT NULL,       -- { floor: number[][], walls: number[][] }
  objects       JSONB NOT NULL DEFAULT '[]',  -- MapObject[]
  spawn_col     INTEGER NOT NULL,
  spawn_row     INTEGER NOT NULL,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);
```

**Drizzle schema** (`src/db/schema.ts`에 추가):

```typescript
export const mapTemplates = pgTable("map_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  icon: varchar("icon", { length: 10 }).notNull().default("🗺️"),
  description: varchar("description", { length: 500 }),
  cols: integer("cols").notNull(),
  rows: integer("rows").notNull(),
  layers: jsonb("layers").notNull(),
  objects: jsonb("objects").notNull().default([]),
  spawnCol: integer("spawn_col").notNull(),
  spawnRow: integer("spawn_row").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
```

SQLite schema (`src/db/schema-sqlite.ts`에 동일 구조):

```typescript
export const mapTemplates = sqliteTable("map_templates", {
  id: text("id").$defaultFn(() => crypto.randomUUID()).primaryKey(),
  name: text("name").notNull(),
  icon: text("icon").notNull().default("🗺️"),
  description: text("description"),
  cols: integer("cols").notNull(),
  rows: integer("rows").notNull(),
  layers: text("layers", { mode: "json" }).notNull(),
  objects: text("objects", { mode: "json" }).notNull().default("[]"),
  spawnCol: integer("spawn_col").notNull(),
  spawnRow: integer("spawn_row").notNull(),
  createdBy: text("created_by").references(() => users.id),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
});
```

**Validation constraints:**
- `cols`: 10–40
- `rows`: 8–30
- `spawnCol`: 0 to cols-1
- `spawnRow`: 0 to rows-1
- `layers.floor` and `layers.walls`: 2D arrays matching cols×rows dimensions

**Seed script:** 기존 `src/lib/map-templates.ts`의 OFFICE, CAFE, CLASSROOM 데이터를 `map_templates` 테이블에 INSERT하는 시드 스크립트 작성. `createdBy`는 null (시스템 생성).

## 2. API Endpoints

### GET `/api/map-templates`

템플릿 목록 조회. layers/objects는 제외하여 경량 응답.

**Response:** `{ templates: [{ id, name, icon, description, cols, rows, createdAt }] }`

### GET `/api/map-templates/:id`

단일 템플릿 상세 조회. layers, objects 포함.

**Response:** `{ id, name, icon, description, cols, rows, layers, objects, spawnCol, spawnRow, createdBy, createdAt, updatedAt }`

### POST `/api/map-templates`

새 템플릿 생성. 인증 필요.

**Request body:**
```json
{
  "name": "My Map",
  "icon": "🏠",
  "description": "A cozy room",
  "cols": 15,
  "rows": 11,
  "layers": { "floor": [[...]], "walls": [[...]] },
  "objects": [...],
  "spawnCol": 7,
  "spawnRow": 9
}
```

**Validation:**
- name: 필수, 1–200자
- cols: 10–40, rows: 8–30
- layers.floor/walls: cols×rows 크기의 2D 배열
- spawnCol/spawnRow: 맵 범위 내
- 스폰 위치가 벽이 아닌지 확인

**Response:** `{ id, ...created template }`

### PUT `/api/map-templates/:id`

템플릿 수정. 인증 필요.

**Request body:** POST와 동일 (부분 업데이트 지원).

### DELETE `/api/map-templates/:id`

템플릿 삭제. 인증 필요.

**Response:** `{ success: true }`

## 3. Map Editor UI

### 3.1 페이지 구조

**Route:** `/map-editor` — 템플릿 목록 + 관리
**Route:** `/map-editor/[id]` — 에디터 (기존 템플릿 수정)
**Route:** `/map-editor/new` — 에디터 (새 맵 생성)

### 3.2 템플릿 목록 페이지 (`/map-editor`)

- 카드 그리드: 각 템플릿을 카드로 표시 (아이콘, 이름, 크기 cols×rows, 설명)
- "새 맵 만들기" 버튼 → `/map-editor/new`
- 각 카드에 편집(→ `/map-editor/[id]`), 복제, 삭제 액션
- 삭제 시 확인 다이얼로그

### 3.3 에디터 페이지 (`/map-editor/[id]` 또는 `/map-editor/new`)

**레이아웃:**

```
┌─────────────────────────────────────────────────────┐
│  [← 목록]     맵 에디터 - "{name}"        [저장]    │
├──────────┬──────────────────────────────────────────┤
│ 팔레트   │                                          │
│          │     Phaser EditorScene                   │
│ [Floor]  │     - 그리드 오버레이                     │
│ [Walls]  │     - 클릭/드래그 페인팅                  │
│ [Objects]│     - 호버 시 타일 미리보기                │
│          │     - 스폰 위치 마커                      │
│ ──────── │                                          │
│ 타일목록  │                                          │
│          │                                          │
│ ──────── │                                          │
│ 도구:    │                                          │
│ ✏️ Paint  │                                          │
│ 🧹 Erase │                                          │
│ ▪️ Fill   │                                          │
│ 📍 Spawn │                                          │
├──────────┴──────────────────────────────────────────┤
│  이름: [___]  크기: [15] × [11]  스폰: (7, 9)      │
│  Undo / Redo                                        │
└─────────────────────────────────────────────────────┘
```

**팔레트 (왼쪽 패널):**

레이어 탭별 아이템:
- **Floor 탭**: Empty(0), Floor(1), Carpet(12)
- **Walls 탭**: Wall(2), Door(7)
- **Objects 탭**: desk, chair, computer, plant, meeting_table, coffee, water_cooler, bookshelf, whiteboard, reception_desk, cubicle_wall

**도구:**
- **Paint (✏️)**: 선택한 타일/오브젝트를 클릭/드래그로 배치
- **Erase (🧹)**: 클릭/드래그로 타일/오브젝트 제거 (해당 레이어만)
- **Fill (▪️)**: 연결된 동일 타일 영역을 선택한 타일로 채우기 (Floor/Walls 레이어만)
- **Spawn (📍)**: 클릭 위치를 스폰 포인트로 설정

**Undo/Redo:**
- 메모리 기반 히스토리 스택 (최대 50 단계)
- 각 액션을 `{ layerName, col, row, prevValue, newValue }` 또는 objects 배열 diff로 기록
- Ctrl+Z / Ctrl+Shift+Z 단축키

### 3.4 Phaser EditorScene

게임의 `GameScene`에서 **렌더링 로직만** 추출하여 `EditorScene`을 구성:

- BootScene → EditorScene (GameScene의 타일 렌더링, 스프라이트 로드 재사용)
- 플레이어 캐릭터, 소켓 통신, NPC 로직 제거
- 그리드 오버레이 추가 (Phaser Graphics)
- 마우스 이벤트 → EventBus로 React에 전달
- React → EventBus로 팔레트 선택/도구 변경 전달

**EventBus 이벤트:**

| 방향 | 이벤트 | 페이로드 |
|------|--------|----------|
| Phaser→React | `editor:tile-click` | `{ col, row, button }` |
| Phaser→React | `editor:tile-drag` | `{ col, row }` |
| Phaser→React | `editor:tile-hover` | `{ col, row }` |
| React→Phaser | `editor:set-tool` | `{ tool: "paint" \| "erase" \| "fill" \| "spawn" }` |
| React→Phaser | `editor:set-layer` | `{ layer: "floor" \| "walls" \| "objects" }` |
| React→Phaser | `editor:set-tile` | `{ tileId: number }` or `{ objectType: string }` |
| React→Phaser | `editor:load-map` | `{ layers, objects, cols, rows }` |
| React→Phaser | `editor:update-tile` | `{ layer, col, row, value }` |
| React→Phaser | `editor:update-objects` | `{ objects: MapObject[] }` |
| React→Phaser | `editor:set-grid` | `{ visible: boolean }` |

### 3.5 새 맵 생성 플로우

1. `/map-editor/new` 접근
2. 다이얼로그: 이름, 아이콘, 설명, cols(10–40), rows(8–30) 입력
3. 확인 시 빈 맵 자동 생성:
   - `floor`: 외벽 내부는 FLOOR(1), 외곽은 EMPTY(0)
   - `walls`: 외곽 WALL(2), 하단 중앙 DOOR(7) 3칸
   - `objects`: 빈 배열
   - `spawnCol/Row`: 하단 문 앞
4. 에디터 진입 → 편집 → 저장

## 4. Channel Creation 변경

`/channels/create` 페이지 수정:

- 기존: 하드코딩 3개 템플릿에서 radio 선택
- 변경: `GET /api/map-templates`로 DB에서 목록 조회 → 카드 선택 UI
- 채널 생성 시 `mapTemplate` 파라미터 대신 `mapTemplateId` (UUID) 전달
- `POST /api/channels` 핸들러: `mapTemplateId`로 DB에서 템플릿 조회 → `mapData`/`mapConfig`에 복사

## 5. Migration & Seed

1. Drizzle migration으로 `map_templates` 테이블 생성
2. 시드 스크립트 (`scripts/seed-map-templates.ts`):
   - `src/lib/map-templates.ts`의 OFFICE, CAFE, CLASSROOM 데이터를 DB에 INSERT
   - `createdBy`: null (시스템 생성)
3. `setup-lite.js` 업데이트: SQLite 스키마 push 후 시드 실행
4. 시드 완료 후 `src/lib/map-templates.ts` 하드코딩 제거 (또는 폴백용 유지)

## 6. File Changes Summary

### New Files
- `src/db/schema.ts` — `mapTemplates` 테이블 추가
- `src/db/schema-sqlite.ts` — SQLite용 `mapTemplates` 추가
- `src/app/api/map-templates/route.ts` — GET (목록), POST (생성)
- `src/app/api/map-templates/[id]/route.ts` — GET, PUT, DELETE
- `src/app/map-editor/page.tsx` — 템플릿 목록/관리 페이지
- `src/app/map-editor/[id]/page.tsx` — 에디터 (수정)
- `src/app/map-editor/new/page.tsx` — 에디터 (신규)
- `src/game/scenes/EditorScene.ts` — Phaser 에디터 씬
- `src/components/MapEditor.tsx` — 에디터 React 컨테이너 (팔레트 + Phaser)
- `src/components/MapTemplatePalette.tsx` — 타일/오브젝트 팔레트
- `src/components/MapTemplateList.tsx` — 템플릿 목록 카드 뷰
- `scripts/seed-map-templates.ts` — 시드 스크립트

### Modified Files
- `src/app/channels/create/page.tsx` — 하드코딩 → DB 조회
- `src/app/api/channels/route.ts` — `mapTemplate` → `mapTemplateId` (DB 조회)
- `src/db/index.ts` — `mapTemplates` export 추가
- `scripts/setup-lite.js` — 시드 실행 추가

### Removed (after migration)
- `src/lib/map-templates.ts` — 하드코딩 제거 (시드로 대체)
