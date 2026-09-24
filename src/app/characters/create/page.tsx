import { redirect } from "next/navigation";

/**
 * "My character" is one per user, so there is no separate creation screen (spec 2026-09-18).
 * `/characters` is a single form for both registration and editing, so this only redirects there.
 */
export default async function CharacterCreatePage({
  searchParams,
}: {
  searchParams: Promise<{ joinChannel?: string }>;
}) {
  const { joinChannel } = await searchParams;
  redirect(
    joinChannel ? `/characters?joinChannel=${encodeURIComponent(joinChannel)}` : "/characters",
  );
}
