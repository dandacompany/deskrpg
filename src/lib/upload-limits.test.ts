import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_TOTAL_BYTES,
  MAX_AUXILIARY_UPLOAD_BYTES,
  MAX_MAIN_UPLOAD_BYTES,
  consumeArchiveEntry,
  validateAuxiliaryUploadSize,
  validateMainUploadSize,
} from "./upload-limits";

test("main upload size rejects oversized payloads", () => {
  assert.equal(validateMainUploadSize(MAX_MAIN_UPLOAD_BYTES), null);
  assert.equal(validateMainUploadSize(MAX_MAIN_UPLOAD_BYTES + 1), "upload_file_too_large");
});

test("auxiliary upload size rejects oversized image payloads", () => {
  assert.equal(validateAuxiliaryUploadSize(MAX_AUXILIARY_UPLOAD_BYTES), null);
  assert.equal(validateAuxiliaryUploadSize(MAX_AUXILIARY_UPLOAD_BYTES + 1), "upload_file_too_large");
});

test("archive budget rejects too many entries", () => {
  let budget = { entries: 0, totalBytes: 0 };
  for (let i = 0; i < MAX_ARCHIVE_ENTRIES; i += 1) {
    const result = consumeArchiveEntry(budget, 1024);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("expected archive entry to be accepted");
    budget = result.budget;
  }

  const overflow = consumeArchiveEntry(budget, 1024);
  assert.equal(overflow.ok, false);
  if (overflow.ok) throw new Error("expected archive entry overflow");
  assert.equal(overflow.errorCode, "upload_archive_too_many_entries");
});

test("archive budget rejects total extracted bytes above limit", () => {
  const result = consumeArchiveEntry(
    { entries: 1, totalBytes: MAX_ARCHIVE_TOTAL_BYTES - 64 },
    128,
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected total bytes overflow");
  assert.equal(result.errorCode, "upload_archive_too_large");
});
