import type { Metadata } from "next";

import GamePageClient from "./GamePageClient";
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
  return <GamePageClient />;
}
