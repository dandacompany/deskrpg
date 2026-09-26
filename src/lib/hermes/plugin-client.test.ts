import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPluginClient } from "./plugin-client";

type Call = { url: string; method: string; auth: string | null; body: string | null };

function recorder(responses: Array<{ status: number; json: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const spec = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(spec.json), {
      status: spec.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("plugin client — token scope", () => {
  it("profile list/create/delete use the default token without a prefix", async () => {
    const { calls, fetchImpl } = recorder([
      { status: 200, json: { profiles: [] } },
      { status: 201, json: { name: "noah", apiKey: "k".repeat(20), keyIssued: true } },
      { status: 200, json: { name: "noah", removed: { profileDir: true, wrapperScript: false } } },
    ]);
    const client = createPluginClient({
      baseUrl: "http://gw:8642",
      defaultToken: "default-key-1234567890",
      fetchImpl,
    });

    await client.listProfiles();
    await client.createProfile("noah");
    await client.deleteProfile("noah");

    assert.equal(calls[0].url, "http://gw:8642/deskrpg/profiles");
    assert.equal(calls[1].url, "http://gw:8642/deskrpg/profiles");
    assert.equal(calls[1].method, "POST");
    // The confirm guard is a plugin requirement — without it you get 400.
    assert.equal(calls[2].url, "http://gw:8642/deskrpg/profiles/noah?confirm=noah");
    assert.equal(calls[2].method, "DELETE");
    for (const call of calls) {
      assert.equal(call.auth, "Bearer default-key-1234567890");
    }
  });

  it("identity/config use the profile prefix and the profile token", async () => {
    const { calls, fetchImpl } = recorder([
      { status: 200, json: { body: "hi", isDefaultTemplate: false, revision: "abc" } },
      { status: 200, json: { model: "gpt-5.6-sol" } },
    ]);
    const client = createPluginClient({
      baseUrl: "http://gw:8642",
      defaultToken: "default-key-1234567890",
      fetchImpl,
    });

    await client.getIdentity("noah", "profile-key-0987654321");
    await client.getConfig("noah", "profile-key-0987654321");

    assert.equal(calls[0].url, "http://gw:8642/p/noah/deskrpg/identity");
    assert.equal(calls[1].url, "http://gw:8642/p/noah/deskrpg/config");
    // Using the default token gets blocked by fail-closed auth with 401.
    for (const call of calls) {
      assert.equal(call.auth, "Bearer profile-key-0987654321");
    }
  });

  it("encodes the profile name in the URL", async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, json: {} }]);
    const client = createPluginClient({ baseUrl: "http://gw:8642", defaultToken: "t", fetchImpl });
    await client.getConfig("a b/c", "pt");
    assert.equal(calls[0].url, "http://gw:8642/p/a%20b%2Fc/deskrpg/config");
  });

  it("putIdentity puts ifRevision in the body", async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, json: { revision: "def" } }]);
    const client = createPluginClient({ baseUrl: "http://gw:8642", defaultToken: "t", fetchImpl });
    await client.putIdentity("noah", "pt", { body: "새 인격", ifRevision: "abc" });
    assert.deepEqual(JSON.parse(calls[0].body!), { body: "새 인격", ifRevision: "abc" });
  });
});

describe("plugin client — failures", () => {
  it("409 comes back as a failure instead of throwing", async () => {
    const { fetchImpl } = recorder([
      { status: 409, json: { error: "revision_conflict", currentRevision: "zzz" } },
    ]);
    const client = createPluginClient({ baseUrl: "http://gw:8642", defaultToken: "t", fetchImpl });
    const res = await client.putIdentity("noah", "pt", { body: "x", ifRevision: "abc" });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.failure.code, "revision_conflict");
    assert.equal(res.status, 409);
  });

  it("200 + unreadable also comes back as a failure", async () => {
    const { fetchImpl } = recorder([
      {
        status: 200,
        json: { body: null, isDefaultTemplate: null, revision: null, unreadable: true },
      },
    ]);
    const client = createPluginClient({ baseUrl: "http://gw:8642", defaultToken: "t", fetchImpl });
    const res = await client.getIdentity("noah", "pt");
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.failure.blocksEditor, true);
  });

  it("network failures don't throw either", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = createPluginClient({ baseUrl: "http://gw:8642", defaultToken: "t", fetchImpl });
    const res = await client.listProfiles();
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.failure.code, "unreachable");
  });

  // I-1 / M-2: a 200 that isn't JSON (an HTML error page, etc.) used to emit {ok:true, data:null}, and
  // the caller threw on `res.data.body`. It must be folded by the same standard as the sibling module
  // plugin-capability.ts — never claim success while sending null.
  it("a 200 that isn't JSON (HTML etc.) does not claim success", async () => {
    const fetchImpl = (async () =>
      new Response("<html>gateway error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const client = createPluginClient({ baseUrl: "http://gw:8642", defaultToken: "t", fetchImpl });
    const res = await client.getIdentity("noah", "pt");
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.failure.code, "malformed_response");
  });

  it("a 200 with a non-object value such as a JSON array does not claim success", async () => {
    const fetchImpl = (async () =>
      new Response("null", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const client = createPluginClient({ baseUrl: "http://gw:8642", defaultToken: "t", fetchImpl });
    const res = await client.listProfiles();
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.failure.code, "malformed_response");
  });
});

describe("plugin client — timeout (I-3)", () => {
  it("folds into the timeout code after timeoutMs when the gateway holds the socket open without responding", async () => {
    // fetchImpl hangs until the signal aborts, then rejects with AbortError — mimicking how the real
    // undici/fetch behaves when given a signal.
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;

    const client = createPluginClient({
      baseUrl: "http://gw:8642",
      defaultToken: "t",
      fetchImpl,
      timeoutMs: 5,
    });
    const res = await client.listProfiles();
    assert.equal(res.ok, false);
    if (res.ok) return;
    // Retrying (unreachable) and checking the address (timeout) are different things for the user to do.
    assert.equal(res.failure.code, "timeout");
  });

  it("handles a response that arrives before the timeout normally", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ profiles: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const client = createPluginClient({
      baseUrl: "http://gw:8642",
      defaultToken: "t",
      fetchImpl,
      timeoutMs: 5000,
    });
    const res = await client.listProfiles();
    assert.equal(res.ok, true);
  });
});

describe("plugin client — staff settings pickers (0.9.0)", () => {
  it("toolset/skill lists are called with the profile path and profile token", async () => {
    const { calls, fetchImpl } = recorder([
      { status: 200, json: { platform: "api_server", toolsets: [] } },
      { status: 200, json: { skills: [] } },
    ]);
    const client = createPluginClient({
      baseUrl: "http://gw:8642",
      defaultToken: "default-key-1234567890",
      fetchImpl,
    });
    await client.getToolsets("no ah", "profile-key-1234567890");
    await client.getSkills("noah", "profile-key-1234567890");
    assert.equal(calls[0].url, "http://gw:8642/p/no%20ah/deskrpg/toolsets");
    assert.equal(calls[0].auth, "Bearer profile-key-1234567890");
    assert.equal(calls[1].url, "http://gw:8642/p/noah/deskrpg/skills");
  });

  it("issues a key for an existing profile on the owner key, sending rotate only when asked", async () => {
    const { calls, fetchImpl } = recorder([
      {
        status: 201,
        json: { name: "no ah", apiKey: "k".repeat(43), issued: true, rotated: false },
      },
      { status: 201, json: { name: "noah", apiKey: "r".repeat(43), issued: true, rotated: true } },
    ]);
    const client = createPluginClient({
      baseUrl: "http://gw:8642",
      defaultToken: "default-key-1234567890",
      fetchImpl,
    });
    const first = await client.issueProfileKey("no ah");
    await client.issueProfileKey("noah", { rotate: true });
    assert.equal(calls[0].url, "http://gw:8642/deskrpg/profiles/no%20ah/key");
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(JSON.parse(calls[0].body!), {});
    assert.deepEqual(JSON.parse(calls[1].body!), { rotate: true });
    assert.ok(calls.every((c) => c.auth === "Bearer default-key-1234567890"));
    assert.ok(first.ok && first.data.issued === true);
  });

  it("puts cloneFrom in the body only when present", async () => {
    const { calls, fetchImpl } = recorder([
      { status: 201, json: { name: "noah", keyIssued: false } },
    ]);
    const client = createPluginClient({
      baseUrl: "http://gw:8642",
      defaultToken: "default-key-1234567890",
      fetchImpl,
    });
    await client.createProfile("noah");
    await client.createProfile("noah", { cloneFrom: "default" });
    assert.deepEqual(JSON.parse(calls[0].body!), { name: "noah" });
    assert.deepEqual(JSON.parse(calls[1].body!), { name: "noah", cloneFrom: "default" });
  });

  it("puts cloneKeys only when present, together with cloneFrom", async () => {
    const { calls, fetchImpl } = recorder([
      {
        status: 201,
        json: {
          name: "noah",
          keyIssued: false,
          cloned: { configKeys: ["model"], envKeys: ["OPENAI_API_KEY"], keyScope: "api_keys" },
        },
      },
    ]);
    const client = createPluginClient({
      baseUrl: "http://gw:8642",
      defaultToken: "default-key-1234567890",
      fetchImpl,
    });
    const res = await client.createProfile("noah", { cloneFrom: "default", cloneKeys: "api_keys" });
    assert.deepEqual(JSON.parse(calls[0].body!), {
      name: "noah",
      cloneFrom: "default",
      cloneKeys: "api_keys",
    });
    assert.equal(res.ok && res.data.cloned?.keyScope, "api_keys");
  });
});

describe("plugin client — provider auth", () => {
  it("the six calls go out with the profile path, token, method and body", async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, json: {} }]);
    const client = createPluginClient({
      baseUrl: "http://gw:8642",
      defaultToken: "default-key-1234567890",
      fetchImpl,
    });
    const t = "profile-key-1234567890";
    await client.startOAuth("noah", t, "openai-codex");
    await client.pollOAuth("noah", t, "openai-codex", "s/1");
    await client.cancelOAuth("noah", t, "s/1");
    await client.disconnectOAuth("noah", t, "openai-codex");
    await client.putProviderKey("noah", t, "openai", "sk-VALUE-123456");
    await client.deleteProviderKey("noah", t, "openai");
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url.replace("http://gw:8642", "")}`),
      [
        "POST /p/noah/deskrpg/oauth/openai-codex/start",
        "GET /p/noah/deskrpg/oauth/openai-codex/sessions/s%2F1",
        "DELETE /p/noah/deskrpg/oauth/sessions/s%2F1",
        "DELETE /p/noah/deskrpg/oauth/openai-codex",
        "PUT /p/noah/deskrpg/provider-keys/openai",
        "DELETE /p/noah/deskrpg/provider-keys/openai",
      ],
    );
    assert.ok(calls.every((c) => c.auth === `Bearer ${t}`));
    assert.deepEqual(JSON.parse(calls[4].body!), { value: "sk-VALUE-123456" });
  });
});
