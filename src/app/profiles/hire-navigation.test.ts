import assert from "node:assert/strict";
import test from "node:test";

import {
  employeeDetailHref,
  hireDoneHref,
  hireFinishedHref,
  hirePageHref,
} from "./hire-navigation";

test("the hiring wizard has its own page address", () => {
  assert.equal(hirePageHref("gw-1"), "/profiles/new?gateway=gw-1");
});

test("carries the employee to keep editing and the place to return to together", () => {
  assert.equal(
    hirePageHref("gw-1", { profile: "oliver", returnTo: "/game?channelId=c1" }),
    "/profiles/new?gateway=gw-1&profile=oliver&returnTo=%2Fgame%3FchannelId%3Dc1",
  );
});

test("if entered from the game, goes back there", () => {
  assert.equal(hireDoneHref("gw-1", "/game?channelId=c1&view=x"), "/game?channelId=c1&view=x");
  assert.equal(hireDoneHref("gw-1", "/game"), "/game");
});

test("otherwise goes back to the list where the just-created employee is visible", () => {
  assert.equal(hireDoneHref("gw 1", null), "/profiles?gateway=gw%201");
});

test("employee detail carries the name in the path and the gateway in the query", () => {
  assert.equal(employeeDetailHref("gw 1", "노아"), "/profiles/%EB%85%B8%EC%95%84?gateway=gw%201");
});

test("finishing the wizard goes to the detail of the employee just created", () => {
  assert.equal(hireFinishedHref("gw-1", null, "mia"), "/profiles/mia?gateway=gw-1");
});

test("if entered from the game or closed without a name, go to the old return place", () => {
  assert.equal(hireFinishedHref("gw-1", "/game", "mia"), "/game");
  assert.equal(hireFinishedHref("gw-1", null, null), "/profiles?gateway=gw-1");
});
