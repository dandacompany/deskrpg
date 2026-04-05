import test from "node:test";
import assert from "node:assert/strict";

import {
  FILE_LIMITS,
  isAllowedFileType,
  extractFileContent,
  buildFilePromptSection,
  buildAttachments,
  type ExtractedFile,
} from "./file-extractor";

// --------------- isAllowedFileType ---------------

test("isAllowedFileType accepts txt", () => {
  assert.equal(isAllowedFileType("readme.txt", "text/plain"), true);
});

test("isAllowedFileType accepts pdf", () => {
  assert.equal(isAllowedFileType("doc.pdf", "application/pdf"), true);
});

test("isAllowedFileType accepts png", () => {
  assert.equal(isAllowedFileType("img.png", "image/png"), true);
});

test("isAllowedFileType accepts xlsx", () => {
  assert.equal(isAllowedFileType("data.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), true);
});

test("isAllowedFileType accepts docx", () => {
  assert.equal(isAllowedFileType("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), true);
});

test("isAllowedFileType accepts csv", () => {
  assert.equal(isAllowedFileType("data.csv", "text/csv"), true);
});

test("isAllowedFileType rejects exe", () => {
  assert.equal(isAllowedFileType("virus.exe", "application/x-msdownload"), false);
});

test("isAllowedFileType rejects zip", () => {
  assert.equal(isAllowedFileType("archive.zip", "application/zip"), false);
});

// --------------- FILE_LIMITS ---------------

test("FILE_LIMITS has correct values", () => {
  assert.equal(FILE_LIMITS.maxFileSize, 5 * 1024 * 1024);
  assert.equal(FILE_LIMITS.maxFileCount, 3);
  assert.equal(FILE_LIMITS.maxTextLength, 50_000);
});

// --------------- extractFileContent ---------------

test("extractFileContent handles plain text", async () => {
  const buf = Buffer.from("Hello, world!", "utf-8");
  const result = await extractFileContent(buf, "hello.txt", "text/plain");
  assert.equal(result.name, "hello.txt");
  assert.equal(result.textContent, "Hello, world!");
  assert.equal(result.imageBase64, null);
  assert.equal(result.truncated, false);
});

test("extractFileContent handles JSON", async () => {
  const obj = { key: "value" };
  const buf = Buffer.from(JSON.stringify(obj), "utf-8");
  const result = await extractFileContent(buf, "data.json", "application/json");
  assert.equal(result.textContent, JSON.stringify(obj));
  assert.equal(result.truncated, false);
});

test("extractFileContent handles CSV", async () => {
  const csv = "a,b,c\n1,2,3";
  const buf = Buffer.from(csv, "utf-8");
  const result = await extractFileContent(buf, "data.csv", "text/csv");
  assert.equal(result.textContent, csv);
  assert.equal(result.truncated, false);
});

test("extractFileContent truncates long text", async () => {
  const longText = "x".repeat(60_000);
  const buf = Buffer.from(longText, "utf-8");
  const result = await extractFileContent(buf, "big.txt", "text/plain");
  assert.equal(result.truncated, true);
  assert.ok(result.textContent!.length <= 50_000 + 200);
  assert.ok(result.textContent!.includes("이하 생략"));
});

test("extractFileContent handles image (1x1 PNG)", async () => {
  const base64Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
  const buf = Buffer.from(base64Png, "base64");
  const result = await extractFileContent(buf, "pixel.png", "image/png");
  assert.equal(result.name, "pixel.png");
  assert.equal(result.mimeType, "image/jpeg"); // converted to JPEG
  assert.equal(result.textContent, null);
  assert.ok(result.imageBase64 !== null);
  assert.ok(!result.imageBase64!.startsWith("data:")); // raw base64, no URI prefix
  assert.equal(result.truncated, false);
});

test("extractFileContent returns error for unsupported type", async () => {
  const buf = Buffer.from("binary stuff");
  const result = await extractFileContent(buf, "file.xyz", "application/octet-stream");
  assert.ok(result.textContent!.includes("지원하지 않는 파일 형식"));
});

// --------------- buildFilePromptSection ---------------

test("buildFilePromptSection returns empty string for no files", () => {
  assert.equal(buildFilePromptSection([]), "");
});

test("buildFilePromptSection formats text file", () => {
  const files: ExtractedFile[] = [
    { name: "note.txt", mimeType: "text/plain", textContent: "hello", imageBase64: null, truncated: false },
  ];
  const result = buildFilePromptSection(files);
  assert.ok(result.includes("첨부파일: note.txt"));
  assert.ok(result.includes("hello"));
});

test("buildFilePromptSection skips image files", () => {
  const files: ExtractedFile[] = [
    { name: "pic.png", mimeType: "image/jpeg", textContent: null, imageBase64: "abc123", truncated: false },
  ];
  const result = buildFilePromptSection(files);
  assert.equal(result, ""); // images go via attachments, not text
});

// --------------- buildAttachments ---------------

test("buildAttachments returns undefined when no images", () => {
  const files: ExtractedFile[] = [
    { name: "note.txt", mimeType: "text/plain", textContent: "hi", imageBase64: null, truncated: false },
  ];
  assert.equal(buildAttachments(files), undefined);
});

test("buildAttachments returns OpenClaw format for images", () => {
  const files: ExtractedFile[] = [
    { name: "pic.png", mimeType: "image/jpeg", textContent: null, imageBase64: "abc123base64data", truncated: false },
  ];
  const result = buildAttachments(files);
  assert.ok(Array.isArray(result));
  assert.equal(result!.length, 1);
  assert.equal(result![0].type, "image");
  assert.equal(result![0].mimeType, "image/jpeg");
  assert.equal(result![0].fileName, "pic.png");
  assert.equal(result![0].content, "abc123base64data");
});
