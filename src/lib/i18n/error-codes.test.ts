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
  "channels.privateChannel",
  "game.loadingEngine",
  "game.sessionKicked",
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

// **Not an exhaustive list.** This is a pinning spot check that guards against the
// code -> translation-key mapping silently drifting. The two tests below own the
// exhaustive checks — whether every registered code has a translation in all 4 locales,
// and whether every errorCode a route actually emits is registered. Listing every code
// here would just copy ERROR_MESSAGE_KEYS and compare it against itself, so the
// `Partial` type is honest about that.
const TEST_CODES: Partial<Record<ErrorCode, string>> = {
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

// An error code being registered alone doesn't put it on screen. If the translation key
// is missing from a locale, getLocalizedMessage falls back and the user sees only a
// generic error message. In practice, not_a_hermes_gateway is sent by the server but was
// in neither the type nor a locale, so the fact that the gateway address was wrong never
// reached the screen at all.
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

/** Walks every .ts file under src to collect the errorCodes routes actually emit. */
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

// The test above only iterates over codes that are **registered**. A code missing
// registration entirely isn't in that table, so it's never iterated over and never
// caught — in practice 23 such codes were left in exactly that state, and a user who
// triggered gateway_in_use_by_channels saw only "an error occurred" (not "can't delete,
// it's bound to a channel").
//
// So flip which side we count from: every code a route **emits** must be registered.
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

// If keys diverge between locales, a user in that language sees **the raw key string**.
// The error-code side is guarded by the two checks above, but nobody was watching UI
// keys (gateways.*, etc.), and in practice the old map editor's toolbar keys were
// leaking with ja/zh missing them.
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

test("fills in a missing body using the header's error code", () => {
  // The shape actually seen in staging: a 502 whose body arrived as {}.
  const headers = {
    get: (n: string) => (n === ERROR_CODE_HEADER ? "gateway_in_use_by_channels" : null),
  };
  assert.deepEqual(withHeaderErrorCode({}, headers), {
    errorCode: "gateway_in_use_by_channels",
  });
});

test("if the body already has a code, the header doesn't overwrite it", () => {
  // The body is richer (has an error message, etc.). The header is only a supplement.
  const headers = { get: () => "gateway_in_use_by_channels" };
  const body = { errorCode: "forbidden", error: "nope" };
  assert.deepEqual(withHeaderErrorCode(body, headers), body);
});

test("leaves it as-is when neither header nor body has one", () => {
  assert.deepEqual(withHeaderErrorCode({}, { get: () => null }), {});
});

test("builds a code from the header alone even when the body isn't an object", () => {
  const headers = { get: () => "not_a_hermes_gateway" };
  assert.deepEqual(withHeaderErrorCode(null, headers), { errorCode: "not_a_hermes_gateway" });
});

// If a locale file defines the same key twice, **the later one silently wins** — editing
// the earlier wording leaves the screen unchanged. TypeScript does catch this at build
// time (`An object literal cannot have multiple properties with the same name`), but
// that's a check that takes minutes, and a commit and push have actually gone out in
// exactly that state before. This catches it in seconds.
//
// The three guards above only checked whether a key **exists**. A duplicate still
// exists, so it slips through that net.
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

test("handoff errors resolve to a user-facing sentence in all four locales", () => {
  const codes = [
    "event_cursor_handoff_required",
    "event_carrier_handoff_pending",
    "event_carrier_handoff_conflict",
    "event_carrier_origin_unknown",
    "carrier_cursor_incomplete",
    "invalid_handoff_cursor",
  ];
  for (const code of codes) {
    const key = ERROR_MESSAGE_KEYS[code as ErrorCode];
    assert.ok(key, code);
    for (const locale of [ko, en, ja, zh]) assert.ok(locale[key], `${code}: ${key}`);
  }
});
