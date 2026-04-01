import assert from "node:assert/strict";
import test from "node:test";

test("resolveRuntimeUploadRequestPath maps upload URLs into the DeskRPG home uploads directory", async () => {
  process.env.DESKRPG_HOME = "/tmp/deskrpg-runtime";
  const runtimeAssets = await import("./runtime-assets.ts");

  assert.equal(
    runtimeAssets.resolveRuntimeUploadRequestPath("/assets/uploads/template-1/tileset.png"),
    "/tmp/deskrpg-runtime/uploads/template-1/tileset.png",
  );
});

test("resolveRuntimeUploadRequestPath rejects path traversal attempts", async () => {
  process.env.DESKRPG_HOME = "/tmp/deskrpg-runtime";
  const runtimeAssets = await import("./runtime-assets.ts");

  assert.equal(
    runtimeAssets.resolveRuntimeUploadRequestPath("/assets/uploads/../../etc/passwd"),
    null,
  );
});
