/**
 * Fetches only an address that passed the guard, under strict caps.
 *
 * Uses `node:http(s)` instead of `fetch`. There's one reason — we need to see the
 * **address it actually connects to**. If we resolve DNS ahead of time and then hand
 * `fetch` a hostname, the name can resolve differently in between (DNS rebinding): a
 * public address at check time, a 10.x at connect time. The `lookup` hook hands us the
 * address the socket actually binds to, so there's no gap.
 *
 * Redirects are followed manually too — automatic redirect-following hides the
 * intermediate hops, letting through the classic bypass of "a public address that
 * bounces to a private one".
 *
 * Three caps: hop count, byte count, time. Without all three, someone else's server can
 * hold our worker hostage.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";

import { isBlockedAddress, parsePreviewTarget } from "./guard";

const MAX_HOPS = 3;
const TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 8_000;

export type FetchGuardedOptions = {
  /** The content-type prefix we accept (`text/html`·`image/`). */
  accept: string;
  /** Truncate the body at this byte count. */
  maxBytes: number;
  /** Asked per hop whether this address (shape·port·host) may be used. Defaults to the real guard. */
  isAllowedUrl?: (url: URL) => Promise<boolean>;
  /** Checks the IP the socket actually binds to. Defaults to blocking private·loopback·link-local. */
  isAllowedAddress?: (address: string) => boolean;
};

export type FetchedBody = {
  /** The **final** address after following all redirects. Used as the base for relative image paths. */
  url: URL;
  body: string;
  contentType: string;
  bytes: Uint8Array;
};

/** The default address policy. Does not connect if any resolved address is private. */
export async function isAllowedPreviewUrl(url: URL): Promise<boolean> {
  return parsePreviewTarget(url.toString()) !== null;
}

type Hop = {
  status: number;
  /** Some servers send compressed content even though `identity` was requested — such responses are discarded. */
  encoding: string;
  location: string | null;
  contentType: string;
  message: IncomingMessage;
};

/** If the host is already an address literal rather than a name, DNS is never consulted — the `lookup` hook is never called. */
function hostIsAddressLiteral(hostname: string): boolean {
  const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function openHop(
  url: URL,
  isAllowedAddress: (address: string) => boolean,
  signal: AbortSignal,
): Promise<Hop | null> {
  if (signal.aborted) return Promise.resolve(null);
  // IP literals never go through `lookup`, so the same policy is applied here directly.
  if (hostIsAddressLiteral(url.hostname)) {
    const literal = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    if (!isAllowedAddress(literal)) return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    let settled = false;
    const done = (value: Hop | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const req = send(
      url,
      {
        // This is where we see the address the socket actually binds to — it closes the gap (rebinding) in the pre-resolve-then-connect approach.
        lookup: (hostname, options, callback) => {
          dnsLookup(hostname, { ...(options as object), all: true }, (err, addresses) => {
            const list = (addresses ?? []) as LookupAddress[];
            if (err || list.length === 0) {
              callback(err ?? new Error("dns_empty"), "", 4);
              return;
            }
            const safe = list.filter((a) => isAllowedAddress(a.address));
            if (safe.length === 0) {
              callback(new Error("blocked_address"), "", 4);
              return;
            }
            // Returns the array if the call asked for `all`, otherwise the first address.
            if ((options as { all?: boolean }).all) {
              (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, safe);
            } else {
              callback(null, safe[0].address, safe[0].family);
            }
          });
        },
        headers: {
          // Most sites withhold og tags if they think we're a bot. We identify ourselves honestly.
          "user-agent": "DeskRPG-LinkPreview/1.0 (+https://deskrpg.com)",
          accept: "text/html,image/*;q=0.9,*/*;q=0.5",
          "accept-language": "ko,en;q=0.8",
          // We don't accept compression. We count the byte cap on the **bytes as received** —
          // accepting a compressed body would make the 512KB cap apply to the pre-compression
          // size, defeating it against a gzip bomb.
          "accept-encoding": "identity",
        },
      },
      (res) => {
        done({
          encoding: (res.headers["content-encoding"] ?? "").toString().toLowerCase(),
          status: res.statusCode ?? 0,
          location: (res.headers.location as string | undefined) ?? null,
          contentType: (res.headers["content-type"] ?? "").toString().toLowerCase(),
          message: res,
        });
      },
    );
    // When the overall budget runs out, the socket is killed regardless of which stage — DNS, headers, or body — it's in.
    const abort = () => req.destroy(new Error("deadline"));
    signal.addEventListener("abort", abort, { once: true });
    req.on("close", () => signal.removeEventListener("abort", abort));
    if (signal.aborted) req.destroy(new Error("deadline"));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.on("error", () => done(null));
    req.end();
  });
}

/** Reads only up to the cap. Once past it, the connection is closed — reading it all and truncating afterward is not a real cap. */
function readCapped(
  message: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const finish = () => resolve(new Uint8Array(Buffer.concat(chunks, total)));
    const abort = () => message.destroy(new Error("deadline"));
    signal.addEventListener("abort", abort, { once: true });
    message.on("close", () => signal.removeEventListener("abort", abort));
    if (signal.aborted) message.destroy(new Error("deadline"));
    message.on("data", (chunk: Buffer) => {
      const room = maxBytes - total;
      if (room <= 0) {
        message.destroy();
        finish();
        return;
      }
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(piece);
      total += piece.length;
      if (total >= maxBytes) {
        message.destroy();
        finish();
      }
    });
    message.on("end", finish);
    message.on("error", finish);
    message.on("close", finish);
  });
}

export async function fetchGuarded(
  target: URL,
  options: FetchGuardedOptions,
): Promise<FetchedBody | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  // The address check is also an async operation. Even if the check itself stalls, we still fall out of the overall budget.
  const expired = new Promise<null>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(null), { once: true });
  });
  try {
    return await Promise.race([fetchWithinDeadline(target, options, controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithinDeadline(
  target: URL,
  options: FetchGuardedOptions,
  signal: AbortSignal,
): Promise<FetchedBody | null> {
  const isAllowed = options.isAllowedUrl ?? isAllowedPreviewUrl;
  const isAllowedAddress = options.isAllowedAddress ?? ((a: string) => !isBlockedAddress(a));
  let url = target;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (signal.aborted || !(await isAllowed(url)) || signal.aborted) return null;

    const res = await openHop(url, isAllowedAddress, signal);
    if (!res) return null;
    if (signal.aborted) {
      res.message.destroy();
      return null;
    }

    if (res.status >= 300 && res.status < 400) {
      // The redirect response body is unused. Letting it stream through keeps the previous hop's socket open.
      res.message.destroy();
      if (!res.location) return null;
      try {
        url = new URL(res.location, url);
      } catch {
        return null;
      }
      url.hash = "";
      continue;
    }

    const compressed = res.encoding !== "" && res.encoding !== "identity";
    if (
      compressed ||
      res.status < 200 ||
      res.status >= 300 ||
      !res.contentType.startsWith(options.accept)
    ) {
      res.message.destroy();
      return null;
    }
    const bytes = await readCapped(res.message, options.maxBytes, signal);
    if (signal.aborted) return null;
    return {
      url,
      bytes,
      contentType: res.contentType,
      body: new TextDecoder().decode(bytes),
    };
  }
  return null;
}
