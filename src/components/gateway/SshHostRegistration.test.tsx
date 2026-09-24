import "../../test-setup/dom";
import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "../../lib/i18n/context";
import SshHostRegistration, { authorizeCommand } from "./SshHostRegistration";

const FP = "SHA256:" + "A".repeat(43);

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("the command that appends the public key to authorized_keys wraps the key in single quotes", () => {
  assert.equal(
    authorizeCommand("ssh-ed25519 AAAA deskrpg@x"),
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo 'ssh-ed25519 AAAA deskrpg@x' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
  );
  assert.match(authorizeCommand("a'b"), /'a'\\''b'/);
});

test("registers only after confirming the scanned fingerprint, and sends that same confirmed fingerprint", async () => {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const data =
      body.action === "ssh-public-key"
        ? { publicKey: "ssh-ed25519 AAAA deskrpg@x" }
        : body.action === "ssh-scan"
          ? { keys: [{ type: "ssh-ed25519", fingerprint: FP }] }
          : { host: { id: "h-0123456789", label: "dante@box" } };
    return new Response(JSON.stringify(data), { status: 200 });
  }) as typeof fetch;
  const registered: unknown[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <I18nProvider initialLocale="ko">
          <SshHostRegistration onRegistered={(h) => registered.push(h)} />
        </I18nProvider>,
      ),
    );
    const field = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
    await act(async () => {
      setValue(field("ssh-host"), "box");
      setValue(field("ssh-user"), "dante");
    });
    const btn = (text: string) =>
      [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
    await act(async () => btn("호스트 키 확인").click());
    assert.match(host.textContent!, new RegExp(FP.replace("+", "\\+")));
    assert.equal(btn("이 서버 등록").disabled, true, "지문 확인 없이 등록할 수 있다");
    await act(async () => field("ssh-fingerprint-confirm").click());
    await act(async () => btn("이 서버 등록").click());
    const reg = bodies.find((b) => b.action === "ssh-register")!;
    assert.deepEqual(reg, {
      action: "ssh-register",
      host: "box",
      port: "22",
      user: "dante",
      fingerprints: [FP],
    });
    assert.deepEqual(registered, [{ id: "h-0123456789", label: "dante@box" }]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = original;
  }
});

test("when the server is unreachable, tells you what to check", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.action === "ssh-scan")
      return new Response(JSON.stringify({ errorCode: "ssh_connection_failed" }), { status: 400 });
    return new Response(JSON.stringify({ publicKey: "ssh-ed25519 AAAA x" }), { status: 200 });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <I18nProvider initialLocale="ko">
          <SshHostRegistration onRegistered={() => {}} />
        </I18nProvider>,
      ),
    );
    const field = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
    await act(async () => {
      setValue(field("ssh-host"), "nowhere");
      setValue(field("ssh-user"), "dante");
    });
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent?.trim() === "호스트 키 확인")!
        .click(),
    );
    assert.match(host.textContent!, /호스트·포트를 확인하세요/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = original;
  }
});
