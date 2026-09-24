const assert = require("node:assert/strict");
const test = require("node:test");

const { CLI_MESSAGES, cliLocale, cliMessage } = require("./cli-messages.js");

test("Korean and English define exactly the same keys", () => {
  assert.deepEqual(Object.keys(CLI_MESSAGES.ko).sort(), Object.keys(CLI_MESSAGES.en).sort());
});

test("Korean and English use the same placeholders for every key", () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of Object.keys(CLI_MESSAGES.ko)) {
    assert.deepEqual(placeholders(CLI_MESSAGES.en[key]), placeholders(CLI_MESSAGES.ko[key]), key);
  }
});

test("English messages contain no Hangul", () => {
  for (const [key, text] of Object.entries(CLI_MESSAGES.en))
    assert.doesNotMatch(text, /[가-힣]/, key);
});

test("cliLocale picks Korean only for a ko* locale, checking LC_ALL, then LC_MESSAGES, then LANG", () => {
  assert.equal(cliLocale({ LANG: "ko_KR.UTF-8" }), "ko");
  assert.equal(cliLocale({ LC_MESSAGES: "ko_KR.UTF-8", LANG: "en_US.UTF-8" }), "ko");
  assert.equal(cliLocale({ LC_ALL: "C", LANG: "ko_KR" }), "en");
  assert.equal(cliLocale({ LC_ALL: "ko_KR.UTF-8", LANG: "en_US.UTF-8" }), "ko");
  assert.equal(cliLocale({ LANG: "ja_JP.UTF-8" }), "en");
  assert.equal(cliLocale({}), "en");
});

test("cliMessage substitutes parameters and leaves unknown ones visible", () => {
  assert.equal(cliMessage("port.free", { port: 3000 }, { LANG: "en_US" }), "Port 3000 is free.");
  assert.equal(
    cliMessage("port.free", { port: 3000 }, { LANG: "ko_KR" }),
    "포트 3000 가 비어 있습니다.",
  );
  assert.equal(cliMessage("port.free", {}, { LANG: "en_US" }), "Port {port} is free.");
});

test("a substituted value is not scanned for placeholders again", () => {
  assert.equal(
    cliMessage("report.warning", { message: "{port}" }, {}),
    "[startup] warning: {port}",
  );
});

test("an unknown key falls back to the key itself", () => {
  assert.equal(cliMessage("no.such.key", {}, {}), "no.such.key");
});
