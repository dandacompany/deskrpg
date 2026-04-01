import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGamePageMetadataTitle,
  canExposeChannelNameForMetadata,
} from "./metadata";

test("buildGamePageMetadataTitle returns DeskRPG fallback without a channel name", () => {
  assert.equal(buildGamePageMetadataTitle(null), "DeskRPG");
  assert.equal(buildGamePageMetadataTitle(""), "DeskRPG");
});

test("buildGamePageMetadataTitle formats the channel title when a channel name exists", () => {
  assert.equal(buildGamePageMetadataTitle("전략 회의실"), "DeskRPG - 전략 회의실");
});

test("canExposeChannelNameForMetadata matches detail access rules", () => {
  assert.equal(
    canExposeChannelNameForMetadata({
      groupId: null,
      isPublic: false,
      hasActiveGroupMembership: false,
      isChannelMember: false,
    }),
    false,
  );

  assert.equal(
    canExposeChannelNameForMetadata({
      groupId: null,
      isPublic: true,
      hasActiveGroupMembership: false,
      isChannelMember: false,
    }),
    true,
  );

  assert.equal(
    canExposeChannelNameForMetadata({
      groupId: "group-1",
      isPublic: false,
      hasActiveGroupMembership: true,
      isChannelMember: true,
    }),
    true,
  );
});
