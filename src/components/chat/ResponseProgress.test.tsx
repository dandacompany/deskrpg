import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import type { ChatResponse } from "@/lib/chat-response";
import ResponseProgress from "./ResponseProgress";

const responses: ChatResponse[] = [
  {
    requestId: "r1",
    sourceMessageId: "s1",
    npcId: "n1",
    npcName: "Sophie",
    status: "streaming",
    content: "First stream",
    updatedAt: 1,
  },
  {
    requestId: "r2",
    sourceMessageId: "s1",
    npcId: "n2",
    npcName: "Mina",
    status: "thinking",
    content: "",
    updatedAt: 2,
  },
];

test("receipt names and two simultaneous response states render independently", async () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <I18nProvider>
        <ResponseProgress responses={responses} receipt />
      </I18nProvider>,
    ),
  );

  assert.match(el.textContent ?? "", /👌/);
  assert.match(el.textContent ?? "", /Sophie/);
  assert.match(el.textContent ?? "", /Mina/);
  assert.equal(el.querySelectorAll("[data-response-request-id]").length, 2);
  assert.match(el.textContent ?? "", /First stream/);
});

test("terminal errors remain visible and do not animate", async () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <I18nProvider>
        <ResponseProgress
          responses={[{ ...responses[0], status: "failed", content: "", error: "adapter_error" }]}
        />
      </I18nProvider>,
    ),
  );

  assert.match(el.textContent ?? "", /Failed/);
  assert.doesNotMatch(el.textContent ?? "", /adapter_error/);
  assert.ok(!el.querySelector(".animate-pulse"));
});
