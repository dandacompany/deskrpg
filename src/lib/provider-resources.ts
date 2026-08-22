import { and, eq, inArray } from "drizzle-orm";

import { db, isPostgres, providerResources, providerShares } from "@/db";

type ProviderResourceRow = typeof providerResources.$inferSelect;
type ProviderShareRow = typeof providerShares.$inferSelect;

const RAW_PROVIDER_CREDENTIALS_PREFIX = "raw:";
const JSON_PROVIDER_CREDENTIALS_PREFIX = "json:";

function nowForDb() {
  return (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date;
}

export function providerNowForDb() {
  return nowForDb();
}

export function serializeProviderCredentials(credentials: unknown): string {
  if (typeof credentials === "string") {
    return `${RAW_PROVIDER_CREDENTIALS_PREFIX}${credentials}`;
  }

  try {
    const serialized = JSON.stringify(credentials);
    if (typeof serialized !== "string") {
      throw new Error("Provider credentials must be JSON-serializable");
    }
    return `${JSON_PROVIDER_CREDENTIALS_PREFIX}${serialized}`;
  } catch {
    throw new Error("Provider credentials must be JSON-serializable");
  }
}

export function parseProviderCredentials(credentialsEncrypted: string | null): unknown {
  if (!credentialsEncrypted) {
    return null;
  }

  if (credentialsEncrypted.startsWith(RAW_PROVIDER_CREDENTIALS_PREFIX)) {
    return credentialsEncrypted.slice(RAW_PROVIDER_CREDENTIALS_PREFIX.length);
  }

  if (credentialsEncrypted.startsWith(JSON_PROVIDER_CREDENTIALS_PREFIX)) {
    return JSON.parse(credentialsEncrypted.slice(JSON_PROVIDER_CREDENTIALS_PREFIX.length));
  }

  try {
    return JSON.parse(credentialsEncrypted);
  } catch {
    return credentialsEncrypted;
  }
}

export function normalizeOptionalProviderText(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error("Expected a string or null");
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function toProviderListItem(
  resource: ProviderResourceRow,
  options: { isOwner: boolean; shareRole: string | null },
) {
  return {
    id: resource.id,
    providerType: resource.providerType,
    displayName: resource.displayName,
    authMethod: resource.authMethod,
    baseUrl: resource.baseUrl,
    ownerUserId: resource.ownerUserId,
    lastValidatedAt: resource.lastValidatedAt,
    lastValidationStatus: resource.lastValidationStatus,
    canEditCredentials: options.isOwner,
    isOwner: options.isOwner,
    shareRole: options.shareRole,
  };
}

export async function getAccessibleProviderResource(userId: string, providerId: string) {
  const [resource] = await db
    .select()
    .from(providerResources)
    .where(eq(providerResources.id, providerId))
    .limit(1);

  if (!resource) {
    return null;
  }

  if (resource.ownerUserId === userId) {
    return { resource, share: null as ProviderShareRow | null, isOwner: true };
  }

  const [share] = await db
    .select()
    .from(providerShares)
    .where(and(eq(providerShares.providerId, providerId), eq(providerShares.userId, userId)))
    .limit(1);

  if (!share) {
    return null;
  }

  return { resource, share, isOwner: false };
}

export async function getOwnedProviderResource(ownerUserId: string, providerId: string) {
  const [resource] = await db
    .select()
    .from(providerResources)
    .where(
      and(eq(providerResources.id, providerId), eq(providerResources.ownerUserId, ownerUserId)),
    )
    .limit(1);

  return resource ?? null;
}

export async function listAccessibleProviderResources(userId: string) {
  const owned = await db
    .select()
    .from(providerResources)
    .where(eq(providerResources.ownerUserId, userId));

  const shares = await db.select().from(providerShares).where(eq(providerShares.userId, userId));

  const sharedProviderIds = shares.map((share) => share.providerId);
  const sharedResources =
    sharedProviderIds.length > 0
      ? await db
          .select()
          .from(providerResources)
          .where(inArray(providerResources.id, sharedProviderIds))
      : [];

  return [
    ...owned.map((resource) => toProviderListItem(resource, { isOwner: true, shareRole: null })),
    ...sharedResources.map((resource) => {
      const share = shares.find((entry) => entry.providerId === resource.id) ?? null;
      return toProviderListItem(resource, { isOwner: false, shareRole: share?.role ?? null });
    }),
  ];
}
