import type { Metadata } from "next";

import GameWebglGate from "./GameWebglGate";
import { resolveGamePageMetadataTitle } from "./metadata";

type GamePageProps = {
  searchParams: Promise<{
    channelId?: string;
  }>;
};

export async function generateMetadata({ searchParams }: GamePageProps): Promise<Metadata> {
  const { channelId } = await searchParams;

  return {
    title: {
      absolute: await resolveGamePageMetadataTitle(channelId),
    },
  };
}

export default function GamePage() {
  // The channel screen mounts only after passing the gate — this file must stay a server component for
  // `generateMetadata` to live. The check is done by the `"use client"` gate below it.
  return <GameWebglGate />;
}
