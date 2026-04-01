# OpenClaw Pairing UX Design

## Goal

DeskRPG currently fails against modern OpenClaw gateways when the gateway requires device pairing. The current UI reduces this to a generic connection failure, which hides the actual next step the user must take.

This design adds a pairing-aware UX to all AI connection entry points so that when OpenClaw returns `PAIRING_REQUIRED`, DeskRPG shows:

- a `페어링 필요` status
- the returned `requestId`
- the CLI approval command the user must run on the OpenClaw server
- copy actions for both the `requestId` and the full approval command
- a retry action so the user can confirm pairing completion without leaving the current flow

## Scope

This design covers:

- Channel creation page AI connection test
- In-game `설정 > 채널 설정 > AI 연결` modal
- NPC hire modal gateway agent area
- Shared backend response shape for pairing-required errors

This design does not cover:

- Automatic pairing approval
- OpenClaw-side CLI/UI changes
- SSH automation
- Persisting pairing state across modal closes beyond normal gateway re-test behavior

## User Flow

### Primary flow

1. The user enters OpenClaw URL and token.
2. The user clicks `연결 테스트` or otherwise triggers gateway access.
3. DeskRPG attempts a real gateway connection.
4. If OpenClaw returns `PAIRING_REQUIRED`, DeskRPG shows a pairing status card instead of a generic error.
5. The user copies the `requestId` or the full CLI command.
6. The user runs the approval command on the OpenClaw server:

```bash
openclaw devices approve <requestId>
```

7. The user returns to DeskRPG and clicks `연결 테스트` again.
8. If the gateway is now paired, DeskRPG transitions to `연결됨`.

### Modal lifetime behavior

- Pairing state is session-scoped to the currently open page or modal.
- If the modal is closed, the state can be discarded.
- Reopening and re-running connection is sufficient because OpenClaw will either:
  - return `PAIRING_REQUIRED` again with a fresh `requestId`, or
  - connect successfully after approval

## UX Model

### Unified status model

All AI connection surfaces use the same conceptual states:

- `idle`
- `connected`
- `pairing_required`
- `error`

`pairing_required` carries extra metadata:

- `requestId`
- `approvalCommand`
- optional raw gateway error text for debugging

### Shared status card

A reusable pairing-aware status card is preferred over ad hoc inline strings.

The card should support:

- visual state variant
  - success
  - warning
  - error
- title
- description
- optional `requestId`
- optional code/command block
- optional action row
  - copy requestId
  - copy approval command
  - retry connection

### Copy and tooltip behavior

For `pairing_required`, the UI should show:

- `Request ID 복사`
- `승인 명령 복사`
- a short help tooltip or helper text that explains:
  - this command must be run on the OpenClaw server terminal
  - pairing is usually a one-time approval for this DeskRPG server device

The exact command displayed is:

```bash
openclaw devices approve <requestId>
```

## Surface-by-Surface Behavior

### 1. Channel creation page

Current behavior only validates URL shape. This is insufficient for pairing-aware flows.

New behavior:

- `연결 테스트` performs a real gateway connection test
- if `PAIRING_REQUIRED`, show the shared pairing status card inline
- if connected, show normal success state
- the user can still create the channel without completing pairing, but the UI should make it clear that AI functionality is not yet connected until pairing succeeds

Reasoning:

- This keeps channel creation and in-game connection behavior consistent
- It prevents users from creating a channel under the false impression that AI is already ready

### 2. In-game AI connection modal

This is the main operational place for troubleshooting.

New behavior:

- `연결 테스트` renders the same shared status card
- pairing card includes `requestId`, approval command, copy buttons, and retry
- success state changes to `연결됨`

This surface should be considered the canonical operational UI for OpenClaw pairing.

### 3. NPC hire modal

The NPC hire modal should not silently collapse pairing failures into an empty agent list.

New behavior:

- when agent list fetch fails with pairing-required, show the same pairing status card above the agent selector
- when agent creation fails with pairing-required, replace the generic creation failure text with a pairing-required message that includes `requestId`
- the modal should make it obvious that agent creation is blocked by OpenClaw approval, not by NPC form validation

## Backend Contract

### Pairing-aware error response

Gateway-related endpoints should return structured pairing metadata whenever the gateway layer reports pairing is required.

Target response shape:

```json
{
  "ok": false,
  "errorCode": "gateway_pairing_required",
  "error": "pairing required (requestId: ...)",
  "requestId": "..."
}
```

This applies to:

- `POST /api/channels/test-gateway`
- `POST /api/channels/[id]/gateway/test`
- `GET /api/channels/[id]/gateway/agents`
- `POST /api/npcs/create-agent`

### Gateway client contract

The OpenClaw gateway client should surface:

- `pairingRequired: true`
- `requestId`
- `code`
- structured `details`

This keeps the UI layer simple and avoids brittle message parsing.

## Component Design

### New reusable component

Introduce a shared component for pairing-aware gateway status presentation.

Recommended responsibility:

- receive normalized state data
- render success, pairing-required, or generic error variants
- own copy button interactions and small helper text

Recommended consumers:

- Channel creation page
- Channel settings modal
- NPC hire modal

This avoids duplicating requestId formatting and copy logic three times.

## Error Handling

### Pairing-required is not a generic failure

DeskRPG should treat `gateway_pairing_required` as an actionable intermediate state, not as a terminal error.

Implications:

- yellow/warning presentation instead of pure red failure when appropriate
- retry CTA should stay visible
- helper text should explain exactly what the user must do next

### Other failures

Non-pairing gateway failures remain regular errors:

- invalid URL
- unauthorized token
- unreachable gateway
- agent list/create RPC failures unrelated to pairing

These continue to use localized generic error handling.

## Testing

### Backend tests

- gateway client test: `PAIRING_REQUIRED` produces `pairingRequired` and `requestId`
- route tests: pairing-required errors are translated into `gateway_pairing_required` with `requestId`

### UI tests

- channel creation page shows pairing card on pairing-required response
- AI connection modal shows pairing card and copy actions
- NPC hire modal shows pairing card when agent listing fails with pairing-required
- retry after mocked success transitions to connected state

### Manual verification

1. configure a real OpenClaw URL/token that is not yet paired
2. verify `PAIRING_REQUIRED` UI appears with `requestId`
3. approve on OpenClaw server
4. retry connection
5. verify connection succeeds
6. verify agent listing and NPC creation then work

## Trade-offs

### Recommended approach

Use a shared pairing status card and real connection tests in both channel creation and in-game settings.

Why:

- consistent UX across entry points
- no hidden empty states in NPC hire flow
- direct mapping from OpenClaw protocol state to user-visible action

### Rejected alternatives

- Keep channel creation as URL-only validation:
  - rejected because it hides real readiness state
- Separate pairing wizard:
  - rejected because it adds unnecessary flow complexity
- Generic error text plus logs only:
  - rejected because it does not guide the user to the required CLI action

## Success Criteria

The feature is successful when:

- users see `페어링 필요` instead of a generic connection failure
- users can copy the `requestId` or approval command directly from DeskRPG
- users can complete approval on the OpenClaw server and retry without guessing the next step
- NPC hire no longer appears broken when the real issue is pending pairing
