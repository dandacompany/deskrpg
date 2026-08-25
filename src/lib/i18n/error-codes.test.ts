import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import en from "./locales/en";
import ja from "./locales/ja";
import ko from "./locales/ko";
import zh from "./locales/zh";
import {
  ERROR_CODE_HEADER,
  ERROR_MESSAGE_KEYS,
  getErrorMessageKey,
  withHeaderErrorCode,
  type ErrorCode,
} from "./error-codes";

const REQUIRED_KEYS = [
  "metadata.title",
  "metadata.description",
  "metadata.openGraphDescription",
  "metadata.keywords",
  "common.unknown",
  "common.preview",
  "common.noPreview",
  "common.loadingGame",
  "common.preparingCharacter",
  "common.backToCharacters",
  "common.renameOnDoubleClick",
  "common.unsavedChangesContinue",
  "game.spawnSetMode",
  "game.fireNpcConfirm",
  "mapEditor.pixel.tolerance",
  "mapEditor.pixel.magicEraser",
  "mapEditor.pixel.smooth",
  "mapEditor.layers.characterNpcDivider",
  "mapEditor.layers.tileLayerType",
  "mapEditor.layers.objectLayerType",
  "mapEditor.layers.roleCollision",
  "mapEditor.layers.roleFloor",
  "mapEditor.layers.roleWalls",
  "mapEditor.layers.roleForeground",
  "mapEditor.layers.roleObjects",
  "mapEditor.template.deleteConfirm",
  "mapEditor.template.openInEditor",
  "mapEditor.template.addMap",
  "mapEditor.template.downloadTmj",
  "mapEditor.template.openFailed",
  "mapEditor.tilesets.deleteInUseConfirm",
  "mapEditor.tilesets.deleteConfirm",
  "mapEditor.tilesets.removeUnusedConfirm",
  "mapEditor.tilesets.importedTileset",
  "mapEditor.newMap.defaultName",
  "mapEditor.project.templateNamePrompt",
  "mapEditor.project.templateDescriptionPrompt",
  "mapEditor.project.templateSaved",
  "mapEditor.project.templateSaveFailed",
  "mapEditor.layers.layerNamePrompt",
  "mapEditor.layers.cannotDeleteCoreLayer",
  "mapEditor.layers.deleteLayerConfirm",
  "npc.aiAgent",
  "npc.gatewayNotConnected",
  "npc.connectGatewayAgent",
  "npc.noAiStatic",
  "npc.loadingAgents",
  "npc.createNewAgent",
  "npc.selectAgent",
  "npc.agentInUse",
  "npc.agentAvailable",
  "npc.limitReached",
  "npc.agentIdValidationChars",
  "npc.agentIdValidationMin",
  "npc.agentIdValidationMax",
  "npc.agentIdExists",
  "npc.agentCreateConnecting",
  "npc.agentCreateDone",
  "npc.agentCreateFailed",
  "npc.agentCreateNetworkError",
  "npc.defaultName",
  "npc.agentIdPlaceholder",
  "meeting.participants",
  "meeting.totalTurns",
  "meeting.npcLabel",
  "chat.returnNpcToOrigin",
  "chat.options",
  "chat.attachFile",
  "chat.removeFile",
  "task.defaultTitle",
  "task.progressReported",
  "channels.privateChannel",
  "game.loadingEngine",
  "game.sessionKicked",
  "game.reportReadyBubble",
  "errors.unauthorized",
  "errors.forbidden",
  "errors.notFound",
  "errors.failedToExportMeeting",
  "errors.channelIdRequired",
  "errors.notAMember",
  "errors.invalidJson",
  "errors.connectionFailed",
  "errors.failedToFetchMeetings",
  "errors.failedToFetchMeeting",
  "errors.failedToFetchChannel",
  "errors.failedToUpdateChannel",
  "errors.failedToDeleteChannel",
  "errors.channelPasswordLengthInvalid",
  "errors.failedToFetchMembers",
  "errors.cannotKickOwner",
  "errors.lastGroupAdminRequired",
  "errors.memberNotFound",
  "errors.failedToKickMember",
  "errors.failedToListTemplates",
  "errors.mapTemplateInvalid",
  "errors.failedToCreateTemplate",
  "errors.failedToGetTemplate",
  "errors.failedToUpdateTemplate",
  "errors.failedToDeleteTemplate",
  "errors.noTiledJsonAvailable",
  "errors.failedToDownloadTemplate",
  "errors.failedToFetchNpcs",
  "errors.missingRequiredFields",
  "errors.missingPersonaOrIdentity",
  "errors.onlyChannelOwnerCanHireNpcs",
  "errors.maxNpcsPerChannel",
  "errors.tileAlreadyOccupied",
  "errors.failedToCreateNpc",
  "errors.npcNotFound",
  "errors.onlyChannelOwnerCanModifyNpcs",
  "errors.failedToUpdateNpc",
  "errors.failedToDeleteNpc",
  "errors.internalServerError",
  "errors.failedToFetchProjects",
  "errors.projectNameRequired",
  "errors.failedToFetchProject",
  "errors.failedToSaveProject",
  "errors.failedToDuplicateProject",
  "errors.failedToDeleteProject",
  "errors.failedToLinkTileset",
  "errors.failedToUnlinkTileset",
  "errors.failedToLinkStamp",
  "errors.failedToUnlinkStamp",
  "errors.failedToFetchMap",
  "errors.invalidMapData",
  "errors.failedToSaveMap",
  "errors.positionRequired",
  "errors.failedToSavePosition",
  "errors.fileRequired",
  "errors.uploadFileTooLarge",
  "errors.uploadArchiveTooLarge",
  "errors.uploadArchiveTooManyEntries",
  "errors.failedToUploadTemplate",
  "errors.failedToFetchStamps",
  "errors.failedToFetchStamp",
  "errors.failedToCreateStamp",
  "errors.failedToUpdateStamp",
  "errors.failedToDeleteStamp",
  "errors.missingChannelOrAgentId",
  "errors.unknownPresetId",
  "errors.failedToCreateAgent",
  "errors.failedToListAgents",
  "errors.agentIdRequired",
  "errors.cannotDeleteMainAgent",
  "errors.agentInUseByNpc",
  "errors.failedToRemoveAgentFromGateway",
  "errors.invalidCredentials",
  "errors.loginIdPasswordRequired",
  "errors.loginIdNicknamePasswordRequired",
  "errors.loginIdLengthInvalid",
  "errors.nicknameLengthInvalid",
  "errors.passwordLengthInvalid",
  "errors.loginIdTaken",
  "errors.nicknameTaken",
  "errors.gatewayUrlRequired",
  "errors.invalidGatewayUrl",
  "errors.gatewayConfigValidated",
  "errors.channelNameRequired",
  "errors.mapTemplateRequired",
  "errors.mapTemplateNotFound",
  "errors.privateChannelPasswordRequired",
  "errors.failedToFetchChannels",
  "errors.failedToCreateChannel",
  "errors.forbidden",
  "errors.notAMember",
  "errors.invalidInviteCode",
  "errors.channelNotFound",
  "errors.passwordRequired",
  "errors.wrongPassword",
  "errors.channelMisconfigured",
  "errors.systemAdminRequired",
  "errors.groupAdminRequired",
  "errors.groupNotFound",
  "errors.failedToJoinChannel",
  "errors.failedToReachTestEndpoint",
  "errors.failedToResolveInviteCode",
  "errors.failedToLoadCharacter",
  "errors.characterNameRequired",
  "errors.characterNameLengthInvalid",
  "errors.maxCharactersReached",
  "errors.failedToUpdateCharacter",
  "errors.failedToCreateCharacter",
  "errors.characterAppearanceInvalid",
  "errors.noCharacterSelected",
  "errors.characterNotFound",
  "errors.failedToLoadCharacterSprite",
  "errors.failedToLoadGameData",
  "errors.failedToFetchTemplate",
  "errors.failedToCreateProject",
  "errors.failedToOpenTemplateForEditing",
  "errors.templateDeleteConfirm",
] as const;

const TEST_CODES: Record<ErrorCode, string> = {
  invalid_credentials: "errors.invalidCredentials",
  login_id_password_required: "errors.loginIdPasswordRequired",
  login_id_nickname_password_required: "errors.loginIdNicknamePasswordRequired",
  login_id_length_invalid: "errors.loginIdLengthInvalid",
  nickname_length_invalid: "errors.nicknameLengthInvalid",
  password_length_invalid: "errors.passwordLengthInvalid",
  login_id_taken: "errors.loginIdTaken",
  nickname_taken: "errors.nicknameTaken",
  gateway_url_required: "errors.gatewayUrlRequired",
  invalid_gateway_url: "errors.invalidGatewayUrl",
  gateway_config_validated: "errors.gatewayConfigValidated",
  channel_name_required: "errors.channelNameRequired",
  map_template_required: "errors.mapTemplateRequired",
  map_template_not_found: "errors.mapTemplateNotFound",
  template_not_found: "errors.mapTemplateNotFound",
  private_channel_password_required: "errors.privateChannelPasswordRequired",
  failed_to_fetch_channels: "errors.failedToFetchChannels",
  failed_to_create_channel: "errors.failedToCreateChannel",
  group_id_required: "errors.missingRequiredFields",
  channel_creation_forbidden: "errors.forbidden",
  group_membership_required: "errors.notAMember",
  public_channel_browse_only: "errors.forbidden",
  invalid_invite_code: "errors.invalidInviteCode",
  channel_not_found: "errors.channelNotFound",
  password_required: "errors.passwordRequired",
  wrong_password: "errors.wrongPassword",
  channel_misconfigured: "errors.channelMisconfigured",
  system_admin_required: "errors.systemAdminRequired",
  group_admin_required: "errors.groupAdminRequired",
  group_not_found: "errors.groupNotFound",
  failed_to_join_channel: "errors.failedToJoinChannel",
  failed_to_reach_test_endpoint: "errors.failedToReachTestEndpoint",
  failed_to_resolve_invite_code: "errors.failedToResolveInviteCode",
  invite_expiration_invalid: "errors.inviteExpirationInvalid",
  group_invite_expired: "errors.groupInviteExpired",
  group_invite_revoked: "errors.groupInviteRevoked",
  group_invite_target_mismatch: "errors.groupInviteTargetMismatch",
  group_invite_already_used: "errors.groupInviteAlreadyUsed",
  already_group_member: "errors.alreadyGroupMember",
  failed_to_load_character: "errors.failedToLoadCharacter",
  character_name_required: "errors.characterNameRequired",
  character_name_length_invalid: "errors.characterNameLengthInvalid",
  max_characters_reached: "errors.maxCharactersReached",
  failed_to_update_character: "errors.failedToUpdateCharacter",
  failed_to_create_character: "errors.failedToCreateCharacter",
  character_appearance_invalid: "errors.characterAppearanceInvalid",
  no_character_selected: "errors.noCharacterSelected",
  character_not_found: "errors.characterNotFound",
  failed_to_load_character_sprite: "errors.failedToLoadCharacterSprite",
  failed_to_load_game_data: "errors.failedToLoadGameData",
  failed_to_fetch_template: "errors.failedToFetchTemplate",
  failed_to_create_project: "errors.failedToCreateProject",
  failed_to_open_template_for_editing: "errors.failedToOpenTemplateForEditing",
  unauthorized: "errors.unauthorized",
  forbidden: "errors.forbidden",
  not_found: "errors.notFound",
  failed_to_export_meeting: "errors.failedToExportMeeting",
  channel_id_required: "errors.channelIdRequired",
  not_a_member: "errors.notAMember",
  invalid_json: "errors.invalidJson",
  connection_failed: "errors.connectionFailed",
  failed_to_fetch_meetings: "errors.failedToFetchMeetings",
  failed_to_fetch_meeting: "errors.failedToFetchMeeting",
  failed_to_fetch_channel: "errors.failedToFetchChannel",
  failed_to_update_channel: "errors.failedToUpdateChannel",
  failed_to_delete_channel: "errors.failedToDeleteChannel",
  channel_password_length_invalid: "errors.channelPasswordLengthInvalid",
  failed_to_fetch_members: "errors.failedToFetchMembers",
  cannot_kick_owner: "errors.cannotKickOwner",
  last_group_admin_required: "errors.lastGroupAdminRequired",
  member_not_found: "errors.memberNotFound",
  failed_to_kick_member: "errors.failedToKickMember",
  failed_to_list_templates: "errors.failedToListTemplates",
  map_template_invalid: "errors.mapTemplateInvalid",
  failed_to_create_template: "errors.failedToCreateTemplate",
  failed_to_get_template: "errors.failedToGetTemplate",
  failed_to_update_template: "errors.failedToUpdateTemplate",
  failed_to_delete_template: "errors.failedToDeleteTemplate",
  no_tiled_json_available: "errors.noTiledJsonAvailable",
  failed_to_download_template: "errors.failedToDownloadTemplate",
  failed_to_fetch_npcs: "errors.failedToFetchNpcs",
  missing_required_fields: "errors.missingRequiredFields",
  missing_persona_or_identity: "errors.missingPersonaOrIdentity",
  only_channel_owner_can_hire_npcs: "errors.onlyChannelOwnerCanHireNpcs",
  max_npcs_per_channel: "errors.maxNpcsPerChannel",
  tile_already_occupied: "errors.tileAlreadyOccupied",
  failed_to_create_npc: "errors.failedToCreateNpc",
  npc_not_found: "errors.npcNotFound",
  only_channel_owner_can_modify_npcs: "errors.onlyChannelOwnerCanModifyNpcs",
  failed_to_update_npc: "errors.failedToUpdateNpc",
  failed_to_delete_npc: "errors.failedToDeleteNpc",
  internal_server_error: "errors.internalServerError",
  failed_to_fetch_projects: "errors.failedToFetchProjects",
  project_name_required: "errors.projectNameRequired",
  failed_to_fetch_project: "errors.failedToFetchProject",
  failed_to_save_project: "errors.failedToSaveProject",
  failed_to_duplicate_project: "errors.failedToDuplicateProject",
  failed_to_delete_project: "errors.failedToDeleteProject",
  map_not_found: "errors.notFound",
  failed_to_fetch_map: "errors.failedToFetchMap",
  invalid_map_data: "errors.invalidMapData",
  failed_to_save_map: "errors.failedToSaveMap",
  position_required: "errors.positionRequired",
  failed_to_save_position: "errors.failedToSavePosition",
  file_required: "errors.fileRequired",
  upload_file_too_large: "errors.uploadFileTooLarge",
  upload_archive_too_large: "errors.uploadArchiveTooLarge",
  upload_archive_too_many_entries: "errors.uploadArchiveTooManyEntries",
  failed_to_upload_template: "errors.failedToUploadTemplate",
  failed_to_fetch_stamps: "errors.failedToFetchStamps",
  failed_to_fetch_stamp: "errors.failedToFetchStamp",
  failed_to_create_stamp: "errors.failedToCreateStamp",
  failed_to_update_stamp: "errors.failedToUpdateStamp",
  failed_to_delete_stamp: "errors.failedToDeleteStamp",
  missing_channel_or_agent_id: "errors.missingChannelOrAgentId",
  unknown_preset_id: "errors.unknownPresetId",
  failed_to_create_agent: "errors.failedToCreateAgent",
  failed_to_list_agents: "errors.failedToListAgents",
  agent_id_required: "errors.agentIdRequired",
  cannot_delete_main_agent: "errors.cannotDeleteMainAgent",
  agent_in_use_by_npc: "errors.agentInUseByNpc",
  failed_to_remove_agent_from_gateway: "errors.failedToRemoveAgentFromGateway",
  gateway_pairing_required: "errors.gatewayPairingRequired",
  registration_disabled: "errors.registrationDisabled",
  invalid_profile_name: "errors.invalidProfileName",
  invalid_token: "errors.invalidToken",
  invalid_profile_id: "errors.invalidProfileId",
  profile_not_found: "errors.profileNotFound",
} as const;

for (const locale of [en, ko, ja, zh]) {
  test("required i18n keys exist in all locales", () => {
    for (const key of REQUIRED_KEYS) {
      assert.ok(locale[key], `Missing translation key: ${key}`);
    }
  });
}

test("error codes map to stable translation keys", () => {
  for (const [code, key] of Object.entries(TEST_CODES)) {
    assert.equal(getErrorMessageKey(code as ErrorCode), key);
  }
});

test("group RBAC error codes map to stable translation keys", () => {
  assert.equal(getErrorMessageKey("group_id_required"), "errors.missingRequiredFields");
  assert.equal(getErrorMessageKey("channel_creation_forbidden"), "errors.forbidden");
  assert.equal(getErrorMessageKey("group_membership_required"), "errors.notAMember");
  assert.equal(getErrorMessageKey("public_channel_browse_only"), "errors.forbidden");
  assert.equal(getErrorMessageKey("system_admin_required"), "errors.systemAdminRequired");
  assert.equal(getErrorMessageKey("group_admin_required"), "errors.groupAdminRequired");
  assert.equal(getErrorMessageKey("group_not_found"), "errors.groupNotFound");
});

// 에러코드는 등록만으로는 화면에 뜨지 않는다. 번역 키가 로케일에 없으면
// getLocalizedMessage 가 fallback 으로 떨어져 사용자는 "오류가 발생했습니다" 만 본다.
// 실제로 not_a_hermes_gateway 는 서버가 보내는데 타입에도 로케일에도 없어서, 게이트웨이
// 주소가 틀렸다는 사실이 화면에 전혀 전달되지 않았다.
test("every registered error code has a message in every locale", () => {
  const locales: Array<[string, Record<string, string>]> = [
    ["ko", ko],
    ["en", en],
    ["ja", ja],
    ["zh", zh],
  ];
  const missing: string[] = [];
  for (const [code, key] of Object.entries(ERROR_MESSAGE_KEYS)) {
    for (const [lang, dict] of locales) {
      if (!dict[key]) missing.push(`${lang}: ${key} (${code})`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    "번역이 없는 에러코드가 있습니다 — 사용자에게는 generic 메시지만 보입니다:\n  " +
      missing.join("\n  "),
  );
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** src 아래 모든 .ts 를 훑어 라우트가 실제로 내보내는 errorCode 를 모은다. */
function emittedErrorCodes(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      if (entry.includes(".test.")) continue;
      const src = readFileSync(full, "utf8");
      for (const m of src.matchAll(/errorCode:\s*"([a-z0-9_]+)"/g)) found.add(m[1]);
    }
  };
  walk(path.join(repoRoot, "src"));
  return found;
}

// 앞 테스트는 **등록된** 코드만 순회한다. 등록 자체가 빠진 코드는 그 표에 없으므로
// 순회 대상이 아니고, 그래서 잡히지 않는다 — 실제로 그 상태로 23개가 남아 있었고
// gateway_in_use_by_channels 를 누른 사용자는 "오류가 발생했습니다" 만 봤다
// ("채널에 묶여 있어 지울 수 없다"가 아니라).
//
// 세는 쪽을 뒤집는다: 라우트가 **보내는** 코드 전부가 등록돼 있어야 한다.
test("every error code a route emits is registered", () => {
  const registered = new Set(Object.keys(ERROR_MESSAGE_KEYS));
  const missing = [...emittedErrorCodes()].filter((c) => !registered.has(c)).sort();
  assert.deepEqual(
    missing,
    [],
    "라우트가 보내지만 등록되지 않은 에러코드입니다 — 사용자에게는 generic 메시지만 " +
      `보입니다:\n  ${missing.join("\n  ")}`,
  );
});

// 로케일 간 키가 어긋나면 그 언어 사용자에게는 **키 문자열이 그대로** 보인다. 에러코드
// 쪽은 위 두 가드가 지키지만 UI 키(gateways.*, mapEditor.* 등)는 아무도 안 봤고,
// 실제로 mapEditor.toolbar.saveAsTemplate 가 ja·zh 에서 빠진 채 새고 있었다.
test("all locales carry the same keys", () => {
  const base = Object.keys(ko).sort();
  const missing: string[] = [];
  for (const [lang, dict] of [
    ["en", en],
    ["ja", ja],
    ["zh", zh],
  ] as const) {
    for (const key of base) if (!(key in dict)) missing.push(`${lang}: ${key}`);
    for (const key of Object.keys(dict)) {
      if (!(key in ko)) missing.push(`ko 에 없는데 ${lang} 에만 있음: ${key}`);
    }
  }
  assert.deepEqual(missing, [], `로케일 키가 어긋납니다:\n  ${missing.join("\n  ")}`);
});

test("헤더의 에러코드로 사라진 본문을 보충한다", () => {
  // 스테이징에서 실제로 겪은 모양: 502 인데 본문이 {} 로 도착했다.
  const headers = {
    get: (n: string) => (n === ERROR_CODE_HEADER ? "gateway_in_use_by_channels" : null),
  };
  assert.deepEqual(withHeaderErrorCode({}, headers), {
    errorCode: "gateway_in_use_by_channels",
  });
});

test("본문에 코드가 있으면 헤더가 덮어쓰지 않는다", () => {
  // 본문이 더 풍부하다(error 문구 등). 헤더는 어디까지나 보충이다.
  const headers = { get: () => "gateway_in_use_by_channels" };
  const body = { errorCode: "forbidden", error: "nope" };
  assert.deepEqual(withHeaderErrorCode(body, headers), body);
});

test("헤더도 본문도 없으면 그대로 둔다", () => {
  assert.deepEqual(withHeaderErrorCode({}, { get: () => null }), {});
});

test("본문이 객체가 아니어도 헤더만으로 코드를 만든다", () => {
  const headers = { get: () => "not_a_hermes_gateway" };
  assert.deepEqual(withHeaderErrorCode(null, headers), { errorCode: "not_a_hermes_gateway" });
});

// 로케일 파일에 같은 키가 두 번 있으면 **뒤엣것이 조용히 이긴다** — 앞의 문구를 고쳐도
// 화면은 그대로다. TypeScript 가 빌드에서 잡아 주지만(`An object literal cannot have
// multiple properties with the same name`), 그건 몇 분짜리 검사이고 실제로 그 상태로
// 커밋·푸시가 나간 적이 있다. 몇 초 안에 잡는다.
//
// 앞의 세 가드는 키의 **존재**만 봤다. 중복은 존재하므로 그물을 빠져나갔다.
test("no locale defines the same key twice", () => {
  const dupes: string[] = [];
  for (const lang of ["ko", "en", "ja", "zh"]) {
    const src = readFileSync(path.join(repoRoot, `src/lib/i18n/locales/${lang}.ts`), "utf8");
    const seen = new Set<string>();
    for (const m of src.matchAll(/^\s*"([^"]+)":/gm)) {
      if (seen.has(m[1])) dupes.push(`${lang}: ${m[1]}`);
      seen.add(m[1]);
    }
  }
  assert.deepEqual(dupes, [], `중복 키는 뒤엣것이 이깁니다:\n  ${dupes.join("\n  ")}`);
});
