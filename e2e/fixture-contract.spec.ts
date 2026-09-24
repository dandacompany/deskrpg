import { test, expect, installGameFixture, assertFixtureRequests } from "./fixtures/game";

test("an unknown API is aborted and reported as a failure including method and path", async ({
  context,
  page,
  fixtureDiagnostics,
  baseURL,
}) => {
  await installGameFixture(context, {
    channelId: "contract",
    characterId: "contract-character",
    handle: async () => false,
  });
  await page.setContent("<title>Fixture contract probe</title>");
  const result = await page.evaluate(async (origin) => {
    try {
      await fetch(`${origin}/api/fixture-unhandled?probe=1`, { method: "POST" });
      return "unexpected success";
    } catch {
      return "aborted";
    }
  }, baseURL);
  expect(result).toBe("aborted");
  expect(fixtureDiagnostics).toEqual(["POST /api/fixture-unhandled?probe=1"]);
  expect(() => assertFixtureRequests(fixtureDiagnostics)).toThrow(/POST \/api\/fixture-unhandled/);
  // Consume only the requests this spec intends. Other API and page errors are caught by the automatic teardown check.
  fixtureDiagnostics.splice(0, 1);
});
