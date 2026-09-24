import assert from "node:assert/strict";
import test from "node:test";

import { WORKSPACE_NAV, employeesHref } from "./workspace-navigation";

test("sidebar has four items in onboarding order — my character first", () => {
  // Without a character, the office screen redirects to the character screen. Making "me"
  // first is the real order, and if it's out of order the user has to guess what's next.
  assert.deepEqual(
    WORKSPACE_NAV.map((item) => item.href),
    ["/characters", "/gateways", "/profiles", "/channels"],
  );
});

test("the legacy AI provider screen is not in the sidebar", () => {
  // Hermes manages provider auth per profile. This screen doesn't connect to that flow.
  assert.equal(
    WORKSPACE_NAV.some((item) => item.href === "/providers"),
    false,
  );
});

test("my character is in the sidebar", () => {
  // A required step, but previously you'd only encounter it when /channels redirected there.
  assert.equal(
    WORKSPACE_NAV.some((item) => item.href === "/characters"),
    true,
  );
});

test("the employees screen URL carries the gateway and follow-up action together", () => {
  assert.equal(employeesHref("gw-1"), "/profiles?gateway=gw-1");
  assert.equal(employeesHref("gw-1", { create: true }), "/profiles/new?gateway=gw-1");
  assert.equal(
    employeesHref("gw-1", { create: true, returnTo: "/game?channelId=c1&view=x" }),
    "/profiles/new?gateway=gw-1&returnTo=%2Fgame%3FchannelId%3Dc1%26view%3Dx",
  );
});
