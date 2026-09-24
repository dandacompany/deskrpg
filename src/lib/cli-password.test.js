"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { resolvePassword } = require("./cli-password");

function deps(overrides) {
  return Object.assign(
    {
      readStdin: async () => {
        throw new Error("readStdin 을 부르면 안 되는 갈래입니다.");
      },
      promptPassword: async () => {
        throw new Error("promptPassword 를 부르면 안 되는 갈래입니다.");
      },
    },
    overrides,
  );
}

test("using --password as given doesn't break existing calls", async () => {
  const got = await resolvePassword(deps({ passwordArg: "hunter2", isTty: true }));
  assert.equal(got, "hunter2");
});

test("--password-stdin takes priority over the argument", async () => {
  // Giving both is a caller mistake, but it's better to pick the safer one.
  const got = await resolvePassword(
    deps({ passwordArg: "from-arg", fromStdin: true, readStdin: async () => "from-pipe\n" }),
  );
  assert.equal(got, "from-pipe");
});

test("only strips the trailing newline from the pipe", async () => {
  // `echo pw | …` appends a newline. But whitespace inside the password is part of the
  // password.
  const got = await resolvePassword(
    deps({ fromStdin: true, readStdin: async () => "  spaced pw  \n" }),
  );
  assert.equal(got, "  spaced pw  ");
});

test("strips only the newline even when it ends in CRLF", async () => {
  const got = await resolvePassword(deps({ fromStdin: true, readStdin: async () => "pw\r\n" }));
  assert.equal(got, "pw");
});

test("prompts when there's nothing and it's a TTY", async () => {
  let asked = 0;
  const got = await resolvePassword(
    deps({
      isTty: true,
      promptPassword: async () => {
        asked++;
        return "typed";
      },
    }),
  );
  assert.equal(got, "typed");
  assert.equal(asked, 1);
});

test("errors out instead of hanging when there's nothing and it's not a TTY", async () => {
  // Showing a prompt here would leave the script silently waiting for input — the worst
  // kind of failure in CI, hanging until it times out.
  await assert.rejects(() => resolvePassword(deps({ isTty: false })), /password required/);
});

test("an empty string argument still counts as an argument — doesn't fall through to the prompt", async () => {
  // `--password ""` is invalid input, but deciding that is a job for length validation.
  // Letting it fall through to the prompt here would hang a non-interactive script.
  const got = await resolvePassword(deps({ passwordArg: "", isTty: true }));
  assert.equal(got, "");
});
