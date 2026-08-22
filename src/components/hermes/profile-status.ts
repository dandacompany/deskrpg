// Pure status→display mapping for Hermes profile validation results. Kept out of any
// component so it can be unit-tested — this codebase has no component-render test
// infrastructure, so all conditional display logic that *can* be a pure function lives
// here instead of inline in JSX.

export type ProfileStatusTone = "ok" | "warn" | "error" | "unknown";

const TONES: Record<string, ProfileStatusTone> = {
  valid: "ok",
  unauthorized: "error",
  unknown_profile: "error",
  unreachable: "warn",
  error: "error",
};

export function profileStatusLabel(status: string | null): {
  tone: ProfileStatusTone;
  key: string;
} {
  if (!status) return { tone: "unknown", key: "gateway.profile.status.unknown" };
  return { tone: TONES[status] ?? "unknown", key: `gateway.profile.status.${status}` };
}
