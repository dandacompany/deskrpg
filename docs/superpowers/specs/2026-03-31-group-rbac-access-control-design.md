# DeskRPG Group RBAC Access Control Design

Date: 2026-03-31
Status: Proposed

## Summary

DeskRPG currently behaves like an open multiplayer instance where any authenticated user can create channels and attach expensive resources such as NPC agents. That is the wrong default for self-hosted deployments.

This design introduces a group-based RBAC model with these rules:

- The first registered user becomes the system administrator.
- The first registered user also gets a default group created automatically.
- Every channel must belong to exactly one group.
- New users can register and log in, but start as groupless users.
- Groupless users can browse instance-wide public channels but cannot join them.
- Users must be invited into a group or have a group join request approved before they can participate in channels.
- Channel creation is denied by default and is granted through group-level permissions with user-level overrides.
- User-level explicit deny overrides all other grants.
- System admins manage the whole instance.
- Group admins manage membership and permissions inside their groups.

The design deliberately stops at a normalized RBAC model and does not introduce a generic policy engine.

## Goals

- Prevent arbitrary authenticated users from creating their own channels and NPC agents by default.
- Support self-hosted deployments where one operator controls who can actually use the instance.
- Add groups as the unit of workspace ownership and administration.
- Allow both invitation-based onboarding and join-request-based onboarding.
- Keep public channel discovery instance-wide.
- Keep permission evaluation deterministic and explainable.
- Make HTTP APIs and Socket.IO joins enforce the same permission rules.

## Non-Goals

- Do not redesign the entire auth system.
- Do not add organization billing, quotas, or SaaS-style tenant isolation.
- Do not implement a fully generic resource/action policy engine.
- Do not migrate existing NPC/channel ownership semantics away from channel owner concepts in the first iteration.
- Do not require existing users or data to be manually rewritten before rollout.

## Current State

Current authority is mostly derived from:

- `channels.ownerId`
- `channel_members.role`
- ad hoc owner checks inside channel and NPC APIs

There is no concept of:

- system-wide administrator
- groups
- pending membership
- invitation or approval workflows
- group-level permissions
- user-level permission overrides

As a result, any authenticated user can become an expensive actor by creating channels and attaching NPCs.

## Proposed Architecture

The new authority model has three layers.

### System Layer

System-level authority applies to the whole DeskRPG instance.

- `system_admin` is the highest authority.
- The first successfully registered user becomes `system_admin`.
- `system_admin` can create groups, assign or revoke group admins, approve global access policies, and manage user-level overrides across all groups.

This role should be represented explicitly so bootstrap and admin UI checks are simple and auditable.

### Group Layer

Groups are the unit of shared workspace ownership.

- Each group has members.
- Each group has zero or more `group_admin` users.
- Each group owns channels.
- Group membership is required for active participation in that group’s channels.
- Group admins can review join requests, issue invites, and manage group-scoped permissions.

Groups are not isolated tenants for visibility. They are management boundaries.

### Channel Layer

Every channel belongs to exactly one group.

- `channels.groupId` is required.
- `isPublic` controls whether the channel appears in the instance-wide public listing.
- Public does not mean universally joinable.
- Group membership and permission rules still determine whether a user can actually enter and interact.

This preserves the existing channel model while attaching it to a group owner.

## Effective Access Rules

### User States

Users can be in one of two practical states after authentication.

1. Groupless user
2. Group member

Groupless users:

- can log in
- can browse instance-wide public channels
- cannot join any channel
- cannot create channels
- cannot create or manage NPC-bearing workspaces

Group members:

- can join channels according to visibility and membership rules
- may create channels if the RBAC evaluator grants `create_channel`

### Visibility vs Participation

Public channel behavior is intentionally split.

- Public channel listing: visible to any authenticated user
- Public channel participation: allowed only to users who belong to at least one group and satisfy join rules for the channel’s owning group

This matches the chosen requirement: groupless users can see public channels but cannot actually participate.

### Permission Evaluation Order

Permission evaluation must be centralized and deterministic.

For a permission such as `create_channel`, evaluation order is:

1. Start from default deny.
2. Apply system-role implicit grants.
3. Apply group-role implicit grants.
4. Apply group permission grants/denies.
5. Apply user permission overrides.
6. If a user-level explicit deny exists, final result is deny regardless of earlier grants.

This is the selected “deny-precedence override” model.

### Initial Implicit Role Semantics

The first version should keep role semantics small.

- `system_admin`:
  - manage all groups
  - manage global overrides
  - create groups
  - can create channels anywhere
- `group_admin`:
  - approve/reject join requests for that group
  - issue/revoke invites for that group
  - manage group membership for that group
  - manage group-level permissions for that group
  - can create channels in that group unless explicitly denied
- `member`:
  - can participate in allowed channels
  - cannot create channels unless explicitly granted

## Data Model

The model should stay normalized and explicit.

### Existing Tables To Extend

#### `users`

Add:

- `system_role`
  - enum/text
  - values: `system_admin`, `user`

Rationale:

- bootstrap logic becomes trivial
- admin UI checks remain simple
- system authority is explicit and auditable

#### `channels`

Add:

- `group_id`
  - required foreign key to `groups`

Keep existing fields such as `ownerId`, `isPublic`, `inviteCode`, and `password`.

`ownerId` still matters for channel-local settings and backwards compatibility, but long-term control should derive from group RBAC.

### New Tables

#### `groups`

Fields:

- `id`
- `name`
- `slug` or stable display key
- `description`
- `createdBy`
- `isDefault`
- `createdAt`
- `updatedAt`

The first system admin’s bootstrap flow auto-creates one default group.

#### `group_members`

Fields:

- `id`
- `groupId`
- `userId`
- `role`
  - `group_admin`
  - `member`
- `joinedAt`
- `approvedBy`
- `approvedAt`

Notes:

- this table stores active memberships only
- invitation and request lifecycle stays in dedicated workflow tables

#### `group_invites`

Fields:

- `id`
- `groupId`
- `token`
- `createdBy`
- `targetUserId` nullable
- `targetLoginId` nullable
- `expiresAt`
- `acceptedBy` nullable
- `acceptedAt` nullable
- `revokedAt` nullable
- `createdAt`

Used for admin-driven onboarding.

#### `group_join_requests`

Fields:

- `id`
- `groupId`
- `userId`
- `status`
  - `pending`
  - `approved`
  - `rejected`
  - `cancelled`
- `message` nullable
- `reviewedBy` nullable
- `reviewedAt` nullable
- `createdAt`

Used for user-initiated onboarding.

#### `group_permissions`

Fields:

- `id`
- `groupId`
- `permissionKey`
- `effect`
  - `allow`
  - `deny`
- `createdBy`
- `createdAt`

These define group-wide baseline rules.

#### `user_permission_overrides`

Fields:

- `id`
- `groupId`
- `userId`
- `permissionKey`
- `effect`
  - `allow`
  - `deny`
- `createdBy`
- `createdAt`

These implement the selected exception model.

### Permission Keys In Scope

Keep the initial permission set intentionally small.

- `create_channel`
- `manage_group_members`
- `manage_group_permissions`
- `approve_join_requests`
- `manage_group_channels`

Future permissions can be added later, but this set covers the current request without overfitting.

## Bootstrap Flow

### First Registration

When the very first user registers:

1. Create the user
2. Assign `system_admin`
3. Create a default group
4. Add the user to that default group as `group_admin`

This should happen transactionally if the current DB mode supports it, or with careful rollback/error handling where it does not.

### Later Registrations

For all later users:

1. Create the user with `system_role = user`
2. Do not attach them to any group
3. Show them the groupless experience after login

## API Design

### New API Domains

Add API surfaces for:

- group listing and creation
- group membership listing
- invite creation, revocation, and acceptance
- join request creation, approval, rejection
- group permission reads and writes
- user override reads and writes

Recommended route families:

- `/api/groups`
- `/api/groups/[id]`
- `/api/groups/[id]/members`
- `/api/groups/[id]/invites`
- `/api/groups/[id]/join-requests`
- `/api/groups/[id]/permissions`
- `/api/groups/[id]/user-overrides`

### Existing Channel APIs

Update channel APIs to require group context and centralized permission checks.

#### `POST /api/channels`

Must:

- require `groupId`
- verify requester is an active member of that group
- evaluate `create_channel`
- reject if denied

This route is the main cost-control boundary because it governs channel and downstream NPC creation.

#### `GET /api/channels`

Should return:

- instance-wide public channels for all authenticated users
- group metadata for channels the user is entitled to see
- participation capability flags, for example:
  - `canView`
  - `canJoin`
  - `requiresGroupMembership`
  - `groupId`
  - `groupName`

This keeps the lobby UI simple and avoids duplicating policy logic in the client.

#### `GET /api/channels/[id]`

Must distinguish:

- visible but not joinable
- password-gated private access
- joinable active membership

Groupless users should never transition from public browse into active channel participation.

#### Join Routes

Both invite-code and direct-join flows must enforce:

- active group membership required before channel participation
- private channel password rules still apply
- public visibility alone is not enough

### Socket.IO Enforcement

Socket joins must not trust prior HTTP checks.

Before joining channel rooms or enabling gameplay/chat events, the server must re-evaluate:

- authenticated user identity
- active group membership
- channel participation allowance

If this is not done, HTTP gating can be bypassed through sockets.

## UI Design

### Groupless User Experience

After login, a groupless user sees:

- public channel directory
- clear “browse only” or “approval required” messaging
- invitations
- join request entry points
- request status list

They do not see:

- channel creation affordances
- group administration controls
- NPC or gateway management entry points

### Group Member Experience

A user who belongs to groups sees:

- groups they belong to
- channels grouped by owning group
- capability-aware buttons
- channel creation only in groups where `create_channel` evaluates to allow

### Group Admin Experience

A group admin needs a focused group management UI for:

- active members
- pending join requests
- active invites
- permission grants/denies
- user-level exceptions

### System Admin Experience

System admins need an instance admin surface for:

- all groups
- system admins and promotion controls
- global user override inspection
- bootstrap diagnostics

## Permission Evaluation Service

Create a single server-side permission evaluator used by:

- REST APIs
- Socket.IO handlers
- SSR capability responses

Recommended interface shape:

- `resolveSystemRole(userId)`
- `resolveGroupMembership(userId, groupId)`
- `resolveEffectivePermissions(userId, groupId)`
- `canCreateChannel(userId, groupId)`
- `canManageGroupMembers(userId, groupId)`
- `canJoinChannel(userId, channelId)`

This service should return both:

- final boolean decision
- explanation metadata when useful for debugging and admin UI

For example:

- source role
- matching group grants
- matching user overrides
- final resolution path

## Error Handling

All access denials should use stable machine-readable error codes instead of free-form text.

New useful error codes include:

- `group_membership_required`
- `group_invite_expired`
- `group_join_request_pending`
- `group_join_request_not_found`
- `channel_creation_forbidden`
- `group_admin_required`
- `system_admin_required`
- `group_not_found`
- `channel_group_mismatch`
- `public_channel_browse_only`

These should be mapped into existing i18n error handling rather than rendered directly from server prose.

## Migration Strategy

This change is large enough that rollout should be staged.

### Phase 1: Schema Introduction

- add new tables and columns
- keep old behavior intact
- create bootstrap backfill for first admin and default group
- assign existing channels into the default group

### Phase 2: Read Path Capability Exposure

- compute group and permission capabilities
- expose them in APIs
- update UI to show browse-only vs joinable states

### Phase 3: Write Path Enforcement

- gate channel creation
- gate join flows
- gate socket room joins

### Phase 4: Admin Tooling

- group admin UI
- invite/join-request UI
- permission management UI

This sequencing minimizes the blast radius and keeps the transition debuggable.

## Existing Data Backfill

For existing deployments:

- pick the earliest existing user as bootstrap `system_admin` if no explicit admin exists
- create the default group
- attach that user as `group_admin`
- assign all existing channels to the default group
- preserve existing channel membership rows

This keeps current installs functional while moving them into the new model.

## Testing Strategy

### Unit Tests

Add unit tests for:

- first-user bootstrap rules
- permission resolution precedence
- user-level deny overriding group allow
- user-level allow overriding group default deny
- groupless public browse vs join denial

### API Tests

Add route-level coverage for:

- channel creation denied for groupless user
- channel creation denied for regular member without permission
- channel creation allowed for group admin
- channel creation allowed for explicitly granted user
- channel creation denied for explicitly denied user
- invite accept flow
- join request approve/reject flow

### Socket Tests

Add integration coverage for:

- denied socket room join for groupless user
- denied socket room join for public-channel browse-only user
- successful room join for valid active member

### Migration Tests

Add migration validation for both Postgres and SQLite:

- schema applies cleanly
- default group is created correctly
- channels backfill with valid `groupId`

## Trade-Offs

The chosen design increases schema and API surface area. That is intentional. The alternative is burying policy in ad hoc booleans and one-off route checks, which becomes opaque quickly once invites, approvals, and overrides exist together.

This design optimizes for:

- explicit authority
- operator control
- explainable permission outcomes
- incremental rollout

It does not optimize for minimum implementation size.

## Recommendation

Proceed with the normalized RBAC design using:

- explicit `system_admin`
- explicit groups and group admins
- group-owned channels
- active membership requirement for participation
- instance-wide public discovery
- default-deny channel creation
- group-level grants with user-level overrides and explicit deny precedence

This is the smallest design that fully matches the requested operating model without boxing the project into a brittle one-off authorization scheme.
