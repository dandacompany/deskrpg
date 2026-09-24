import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isBlockedAddress,
  isSafeImageType,
  normalizePreviewUrl,
  parsePreviewTarget,
} from "./guard";

test("blocks private, loopback, link-local, and CGNAT addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254", // cloud metadata — blocking this is this guard's whole reason to exist
    "100.64.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isBlockedAddress(ip), true, `막아야 한다: ${ip}`);
  }
});

test("public addresses pass", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) {
    assert.equal(isBlockedAddress(ip), false, `통과해야 한다: ${ip}`);
  }
});

test("rejects non-http(s) addresses", () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)"]) {
    assert.equal(parsePreviewTarget(url), null, url);
  }
});

test("rejects addresses with embedded credentials — the proxy never carries someone else's auth", () => {
  assert.equal(parsePreviewTarget("https://user:pw@example.com/"), null);
});

test("rejects non-standard ports — otherwise this becomes a way to port-scan the internal network", () => {
  assert.equal(parsePreviewTarget("https://example.com:8080/"), null);
  assert.ok(parsePreviewTarget("https://example.com:443/"));
  assert.ok(parsePreviewTarget("http://example.com:80/"));
});

test("rejects a host that is already a private IP literal, without even looking at DNS", () => {
  assert.equal(parsePreviewTarget("http://169.254.169.254/latest/meta-data/"), null);
  assert.equal(parsePreviewTarget("http://[::1]/"), null);
  assert.equal(parsePreviewTarget("http://localhost/"), null);
});

test("a normal address is stripped of its hash and returned normalized", () => {
  const url = parsePreviewTarget("https://Example.com/a/b?q=1#frag");
  assert.equal(url?.toString(), "https://example.com/a/b?q=1");
});

test("normalization only checks shape — a private address with the right shape passes through (the address verdict happens right before the request)", () => {
  assert.ok(normalizePreviewUrl("http://127.0.0.1/p"));
  assert.equal(normalizePreviewUrl("file:///etc/passwd"), null);
  assert.equal(normalizePreviewUrl("https://a:b@example.com/"), null);
  // Port is a destination verdict, not a shape check — parsePreviewTarget blocks it.
  assert.ok(normalizePreviewUrl("https://example.com:8080/"));
  assert.equal(parsePreviewTarget("https://example.com:8080/"), null);
});

test("the only image types the proxy will return are raster — svg can carry scripts", () => {
  for (const ok of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]) {
    assert.equal(isSafeImageType(ok), true, ok);
  }
  for (const bad of [
    "image/svg+xml",
    "image/svg+xml; charset=utf-8",
    "text/html",
    "application/xml",
    "",
  ]) {
    assert.equal(isSafeImageType(bad), false, bad);
  }
});

// A bypass dev1 observed in `a3c93fd7` (2026-09-20). The URL parser normalizes
// `[::ffff:127.0.0.1]` to the hex notation `[::ffff:7f00:1]`, which let every check that
// looked at the notation with a regex pass through. Linux dual-stack sockets route a
// `::ffff:a.b.c.d` connection to IPv4 `a.b.c.d`.
test("an IPv4-mapped IPv6 address normalized by the URL parser still cannot reach the internal network", () => {
  for (const raw of [
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::127.0.0.1]/",
    "http://[64:ff9b::127.0.0.1]/",
    "http://[2002:7f00:1::]/",
  ]) {
    assert.equal(parsePreviewTarget(raw), null, `${raw} → ${new URL(raw).hostname}`);
  }
});

test("blocks the normalized hex notation itself too — DNS or a redirect can return it in this form", () => {
  for (const address of [
    "::ffff:7f00:1", // 127.0.0.1
    "::ffff:a9fe:a9fe", // 169.254.169.254
    "::ffff:a00:1", // 10.0.0.1
    "::ffff:c0a8:1", // 192.168.0.1
    "64:ff9b::7f00:1", // loopback wrapped in NAT64
    "2002:a00:1::", // 10.0.0.1 wrapped in 6to4
    "::1",
    "fe80::1",
    "fc00::1",
    "fe80::1%en0", // even with a scope identifier attached
    "2001:db8::1", // documentation-only
    "2001::1", // Teredo
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
});

test("only global unicast passes — IPv6 is judged by an allowlist", () => {
  for (const address of ["2606:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
  // Outside 2000::/3 is blocked even without knowing what it is.
  for (const address of ["3ffe::1", "0100::1", "ff02::1"]) {
    assert.equal(isBlockedAddress(address), address !== "3ffe::1", address);
  }
});

test("blocks strings that are not IPs — nothing unrecognized gets through", () => {
  for (const junk of ["example.com", "", "::ffff:999.1.1.1", "1:2:3", "not-an-ip"]) {
    assert.equal(isBlockedAddress(junk), true, JSON.stringify(junk));
  }
});
