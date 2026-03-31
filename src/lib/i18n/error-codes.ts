export type ErrorCode =
  | "invalid_credentials"
  | "login_id_password_required"
  | "login_id_nickname_password_required"
  | "login_id_length_invalid"
  | "nickname_length_invalid"
  | "password_length_invalid"
  | "login_id_taken"
  | "nickname_taken"
  | "gateway_url_required"
  | "invalid_gateway_url"
  | "gateway_config_validated"
  | "channel_name_required"
  | "group_id_required"
  | "map_template_required"
  | "map_template_not_found"
  | "template_not_found"
  | "private_channel_password_required"
  | "channel_creation_forbidden"
  | "failed_to_fetch_channels"
  | "failed_to_create_channel"
  | "invalid_invite_code"
  | "channel_not_found"
  | "password_required"
  | "wrong_password"
  | "channel_misconfigured"
  | "group_membership_required"
  | "public_channel_browse_only"
  | "failed_to_join_channel"
  | "failed_to_reach_test_endpoint"
  | "failed_to_resolve_invite_code"
  | "failed_to_load_character"
  | "character_name_required"
  | "character_name_length_invalid"
  | "max_characters_reached"
  | "failed_to_update_character"
  | "failed_to_create_character"
  | "character_appearance_invalid"
  | "no_character_selected"
  | "character_not_found"
  | "failed_to_load_character_sprite"
  | "failed_to_load_game_data"
  | "failed_to_fetch_template"
  | "failed_to_create_project"
  | "failed_to_open_template_for_editing"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "channel_id_required"
  | "not_a_member"
  | "invalid_json"
  | "connection_failed"
  | "failed_to_fetch_meetings"
  | "failed_to_fetch_meeting"
  | "failed_to_fetch_channel"
  | "failed_to_update_channel"
  | "failed_to_delete_channel"
  | "channel_password_length_invalid"
  | "failed_to_fetch_members"
  | "cannot_kick_owner"
  | "member_not_found"
  | "failed_to_kick_member"
  | "failed_to_list_templates"
  | "map_template_invalid"
  | "failed_to_create_template"
  | "failed_to_get_template"
  | "failed_to_update_template"
  | "failed_to_delete_template"
  | "no_tiled_json_available"
  | "failed_to_download_template"
  | "failed_to_fetch_npcs"
  | "missing_required_fields"
  | "missing_persona_or_identity"
  | "only_channel_owner_can_hire_npcs"
  | "max_npcs_per_channel"
  | "tile_already_occupied"
  | "failed_to_create_npc"
  | "npc_not_found"
  | "only_channel_owner_can_modify_npcs"
  | "failed_to_update_npc"
  | "failed_to_delete_npc"
  | "internal_server_error"
  | "failed_to_fetch_projects"
  | "project_name_required"
  | "failed_to_fetch_project"
  | "failed_to_save_project"
  | "failed_to_duplicate_project"
  | "failed_to_delete_project"
  | "map_not_found"
  | "failed_to_fetch_map"
  | "invalid_map_data"
  | "failed_to_save_map"
  | "position_required"
  | "failed_to_save_position"
  | "file_required"
  | "failed_to_upload_template"
  | "failed_to_fetch_stamps"
  | "failed_to_fetch_stamp"
  | "failed_to_create_stamp"
  | "failed_to_update_stamp"
  | "failed_to_delete_stamp"
  | "failed_to_export_meeting"
  | "missing_channel_or_agent_id"
  | "unknown_preset_id"
  | "failed_to_create_agent"
  | "failed_to_list_agents"
  | "agent_id_required"
  | "cannot_delete_main_agent"
  | "agent_in_use_by_npc"
  | "failed_to_remove_agent_from_gateway";

const ERROR_MESSAGE_KEYS: Record<ErrorCode, string> = {
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
  group_id_required: "errors.missingRequiredFields",
  map_template_required: "errors.mapTemplateRequired",
  map_template_not_found: "errors.mapTemplateNotFound",
  template_not_found: "errors.mapTemplateNotFound",
  private_channel_password_required: "errors.privateChannelPasswordRequired",
  channel_creation_forbidden: "errors.forbidden",
  failed_to_fetch_channels: "errors.failedToFetchChannels",
  failed_to_create_channel: "errors.failedToCreateChannel",
  invalid_invite_code: "errors.invalidInviteCode",
  channel_not_found: "errors.channelNotFound",
  password_required: "errors.passwordRequired",
  wrong_password: "errors.wrongPassword",
  channel_misconfigured: "errors.channelMisconfigured",
  group_membership_required: "errors.notAMember",
  public_channel_browse_only: "errors.forbidden",
  failed_to_join_channel: "errors.failedToJoinChannel",
  failed_to_reach_test_endpoint: "errors.failedToReachTestEndpoint",
  failed_to_resolve_invite_code: "errors.failedToResolveInviteCode",
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
  failed_to_upload_template: "errors.failedToUploadTemplate",
  failed_to_fetch_stamps: "errors.failedToFetchStamps",
  failed_to_fetch_stamp: "errors.failedToFetchStamp",
  failed_to_create_stamp: "errors.failedToCreateStamp",
  failed_to_update_stamp: "errors.failedToUpdateStamp",
  failed_to_delete_stamp: "errors.failedToDeleteStamp",
  failed_to_export_meeting: "errors.failedToExportMeeting",
  missing_channel_or_agent_id: "errors.missingChannelOrAgentId",
  unknown_preset_id: "errors.unknownPresetId",
  failed_to_create_agent: "errors.failedToCreateAgent",
  failed_to_list_agents: "errors.failedToListAgents",
  agent_id_required: "errors.agentIdRequired",
  cannot_delete_main_agent: "errors.cannotDeleteMainAgent",
  agent_in_use_by_npc: "errors.agentInUseByNpc",
  failed_to_remove_agent_from_gateway: "errors.failedToRemoveAgentFromGateway",
};

type Translator = (key: string, params?: Record<string, string | number>) => string;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && value in ERROR_MESSAGE_KEYS;
}

export function getErrorMessageKey(code: ErrorCode): string {
  return ERROR_MESSAGE_KEYS[code];
}

export function getLocalizedMessage(
  t: Translator,
  keyOrCode: string,
  fallbackKey?: string,
): string {
  if (keyOrCode.startsWith("errors.")) {
    return t(keyOrCode);
  }
  if (isErrorCode(keyOrCode)) {
    return t(getErrorMessageKey(keyOrCode));
  }
  return fallbackKey ? t(fallbackKey) : keyOrCode;
}

export function getLocalizedErrorMessage(
  t: Translator,
  payload: unknown,
  fallbackKey?: string,
): string {
  if (!payload || typeof payload !== "object") {
    return fallbackKey ? t(fallbackKey) : "";
  }

  const data = payload as {
    errorCode?: unknown;
    messageCode?: unknown;
    error?: unknown;
    message?: unknown;
  };

  if (typeof data.messageCode === "string") {
    return getLocalizedMessage(t, data.messageCode, fallbackKey);
  }

  if (typeof data.errorCode === "string") {
    return getLocalizedMessage(t, data.errorCode, fallbackKey);
  }

  if (typeof data.error === "string") {
    return getLocalizedMessage(t, data.error, fallbackKey);
  }

  if (typeof data.message === "string") {
    return getLocalizedMessage(t, data.message, fallbackKey);
  }

  return fallbackKey ? t(fallbackKey) : "";
}
