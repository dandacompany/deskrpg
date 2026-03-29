# Tiled Map Editor Integration — Design Spec

**Date:** 2026-03-27
**Status:** Approved

## Overview

Tiled Map Editor를 DeskRPG의 기본 맵 에디터로 채택한다. 기존 커스텀 Phaser 에디터를 제거하고, 사용자가 Tiled에서 맵을 제작한 뒤 Tiled JSON(.tmj)을 업로드하여 사용하는 방식으로 전환한다. Phaser의 내장 Tiled JSON 로딩 기능을 활용하여 런타임에서 직접 로드한다.

## Decisions

| 항목 | 결정 |
|------|------|
| 기존 에디터 | 완전 교체 — `/map-editor`를 Tiled JSON 관리 페이지로 변경 |
| 타일셋 제공 | 스타터 키트 (타일셋 PNG + TSX + 샘플 맵 zip 다운로드) |
| 저장 형식 | Tiled JSON 원본 그대로 DB에 저장 |
| 타일셋 호스팅 | 기본 타일셋 `public/assets/tiled-kit/` + 커스텀 타일셋 업로드 |

## 1. Tiled Starter Kit

`public/assets/tiled-kit/` 에 기본 제공:

```
tiled-kit/
├── deskrpg-tileset.png         ← 기본 타일셋 이미지 (오픈소스 에셋 조합, 32x32)
├── deskrpg-tileset.tsx          ← Tiled 타일셋 정의 파일
├── deskrpg-objects.png          ← 오브젝트/가구 스프라이트시트
├── deskrpg-objects.tsx          ← 오브젝트 타일셋 정의
├── sample-office.tmj            ← 샘플 오피스 맵 (기존 Office 템플릿 변환)
├── sample-cafe.tmj              ← 샘플 카페 맵
├── sample-classroom.tmj         ← 샘플 교실 맵
└── README.md                    ← Tiled 설치 + 사용법 안내
```

**타일셋 구성:**
- `deskrpg-tileset.png`: 바닥/벽/문 등 기본 타일 (기존 BootScene의 16타일 → PNG로 export)
- `deskrpg-objects.png`: 가구 오브젝트들 (기존 object-textures.ts의 11종 → PNG로 export)
- TSX 파일: Tiled가 타일 속성(collision, type 등)을 인식할 수 있도록 메타데이터 정의

**스타터 키트 zip:**
- `/map-editor` 페이지에서 다운로드 버튼 제공
- 위 파일들을 zip으로 묶어 제공

**Tiled 맵 규약 (README에 문서화):**
- 레이어 이름: `floor` (바닥), `walls` (벽/구조물), `objects` (오브젝트 레이어)
- `objects` 레이어: Tiled Object Layer로, 타일 오브젝트를 배치
- 스폰 포인트: `objects` 레이어에 `spawn` 이름의 Point 오브젝트로 지정
- 충돌: `walls` 레이어의 타일 중 `collision: true` 속성을 가진 타일

## 2. DB Schema 변경

`map_templates` 테이블 수정:

```sql
-- 추가
tiled_json  JSONB NOT NULL           -- Tiled JSON 원본 전체

-- 유지 (메타데이터, 목록 표시용)
cols        INTEGER NOT NULL
rows        INTEGER NOT NULL
spawn_col   INTEGER NOT NULL
spawn_row   INTEGER NOT NULL

-- 제거 (deprecated)
layers      -- 기존 커스텀 포맷, NULL 허용으로 전환 후 점진 제거
objects     -- 기존 커스텀 포맷, 동일
```

실제 구현: `layers`/`objects`를 NOT NULL에서 nullable로 변경하고, 새 `tiledJson` 컬럼 추가. 기존 데이터는 마이그레이션 스크립트로 변환.

## 3. 타일셋 이미지 호스팅

**기본 타일셋:**
- `public/assets/tiled-kit/deskrpg-tileset.png`
- `public/assets/tiled-kit/deskrpg-objects.png`
- Tiled JSON 내에서 상대경로로 참조: `"image": "deskrpg-tileset.png"`
- Phaser 로딩 시 `"/assets/tiled-kit/"` 접두어를 붙여 resolve

**커스텀 타일셋 업로드:**
- `public/assets/uploads/{templateId}/` 에 저장
- 업로드 API가 Tiled JSON 내 이미지 경로를 파싱하여 필요한 파일 확인
- 기본 타일셋만 사용하면 추가 업로드 불필요

## 4. API 변경

### POST `/api/map-templates/upload` (신규)

```
Content-Type: multipart/form-data
Fields:
  - tmjFile: .tmj 파일 (필수)
  - tilesetFiles: .png 파일들 (선택, 커스텀 타일셋)
  - name: 템플릿 이름
  - icon: 이모지 아이콘
  - description: 설명
  - tags: 태그
```

서버 처리:
1. TMJ 파일 파싱 → JSON 검증
2. 맵 크기 추출 (width/height from JSON)
3. 스폰 포인트 추출 (objects 레이어에서 "spawn" 포인트)
4. 타일셋 이미지 경로 확인 → 기본 타일셋이면 OK, 아니면 업로드 필수
5. 커스텀 타일셋 파일을 `public/assets/uploads/{id}/` 에 저장
6. Tiled JSON 내 이미지 경로를 서빙 경로로 치환
7. DB에 저장

### PUT `/api/map-templates/:id` (수정)

기존 layers/objects 대신 tiledJson 업데이트.

### GET `/api/map-templates/:id` (수정)

tiledJson 포함하여 반환.

### GET `/api/map-templates/:id/download` (신규)

Tiled JSON 파일을 .tmj로 다운로드 (Tiled에서 다시 열기용).

## 5. GameScene 변경

### 현재 (커스텀 포맷):
```typescript
const floorMap = this.make.tilemap({ data: this.floorData, tileWidth: 32, tileHeight: 32 });
const tileset = floorMap.addTilesetImage("office-tiles", "office-tiles");
```

### 변경 (Tiled JSON):
```typescript
// 1. Tiled JSON을 cache에 로드
this.cache.tilemap.add("channel-map", { format: Phaser.Tilemaps.Formats.TILED_JSON, data: tiledJsonData });

// 2. 타일셋 이미지 로드 (preload 또는 동적)
this.load.image("deskrpg-tileset", "/assets/tiled-kit/deskrpg-tileset.png");

// 3. 타일맵 생성
const map = this.make.tilemap({ key: "channel-map" });
const tileset = map.addTilesetImage("deskrpg-tileset", "deskrpg-tileset");

// 4. 레이어 생성
const floorLayer = map.createLayer("floor", tileset);
const wallsLayer = map.createLayer("walls", tileset);
wallsLayer.setCollisionByProperty({ collision: true });

// 5. 오브젝트 레이어에서 가구 스폰
const objectLayer = map.getObjectLayer("objects");
for (const obj of objectLayer.objects) {
  // 타일 오브젝트 → 스프라이트 생성
}

// 6. 스폰 포인트
const spawnPoint = objectLayer.objects.find(o => o.name === "spawn");
```

### Collision 처리:
- Tiled에서 타일에 `collision` custom property 설정
- Phaser의 `setCollisionByProperty()` 로 자동 충돌 설정
- 기존 `COLLISION_TILES` Set 기반 충돌 → Tiled property 기반으로 전환

### 하위 호환:
- 채널의 `mapData`가 기존 커스텀 포맷이면 `detectAndConvertMapData()` 로 폴백
- 새 `tiledJson` 필드가 있으면 Tiled 로더 사용
- 채널 테이블의 `mapData`/`mapConfig`는 그대로 유지 (기존 채널 호환)

## 6. `/map-editor` 페이지 변경

기존 Phaser 에디터 제거 → 템플릿 관리 대시보드:

- 템플릿 목록 (썸네일, 이름, 크기, 태그)
- "Upload .tmj" 버튼 → 파일 업로드 다이얼로그
- "Download Starter Kit" 버튼 → zip 다운로드
- 각 템플릿: Edit(다운로드 .tmj) / Delete / Export(JSON)
- 검색/태그 필터 (기존 유지)

## 7. 삭제할 파일

| 파일 | 이유 |
|------|------|
| `src/game/scenes/EditorScene.ts` | Tiled가 대체 |
| `src/game/scenes/EditorBootScene.ts` | 에디터 전용 |
| `src/game/editor-main.ts` | 에디터 전용 |
| `src/components/MapEditorPhaser.tsx` | 에디터 전용 |
| `src/components/MapEditorPalette.tsx` | 에디터 전용 |
| `src/components/MapEditorToolbar.tsx` | 에디터 전용 |
| `src/app/map-editor/[id]/page.tsx` | Phaser 에디터 → 업로드 관리로 교체 |
| `src/app/map-editor/new/page.tsx` | 업로드로 대체 |
| `src/lib/map-editor-utils.ts` | generateBlankMap, EditorHistory 등 불필요 (validateMapTemplate은 유지 가능) |

## 8. 유지할 것

- `map_templates` 테이블 (스키마 수정)
- `/api/map-templates` API (수정)
- `/map-editor/page.tsx` (UI 변경)
- `object-types.ts` (충돌, 렌더링)
- `object-textures.ts` (GameScene 폴백 렌더링)
- `map-thumbnail.ts` (Tiled JSON 파싱으로 변경)
- 채널 생성 흐름 (템플릿 선택)
- `BootScene.ts` (타일셋 생성 — 폴백 + Tiled 타일셋 이미지 로딩)

## 9. 타일셋 PNG 생성

기존 BootScene에서 코드로 그리는 16개 타일과 11개 오브젝트를 PNG 파일로 export하는 빌드 스크립트 필요:

```
scripts/export-tileset.ts
  → Node.js canvas로 BootScene과 동일한 그리기 로직 실행
  → public/assets/tiled-kit/deskrpg-tileset.png (16타일, 512x32)
  → public/assets/tiled-kit/deskrpg-objects.png (11오브젝트)
  → public/assets/tiled-kit/deskrpg-tileset.tsx (Tiled 타일셋 정의)
```

## 10. 마이그레이션

기존 3개 시드 템플릿을 Tiled JSON으로 변환:

```
scripts/convert-templates-to-tiled.ts
  → 기존 map-template-data.ts의 floor/walls/objects 배열을 Tiled JSON 구조로 변환
  → 결과를 tiled-kit/sample-*.tmj 로 저장
  → DB 시드 스크립트 업데이트
```
