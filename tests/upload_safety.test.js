"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_CSV_UPLOAD_BYTES,
  validateCsvUpload,
} = require("../lib/uploadSafety.js");

async function multipart(filename, content, type = "text/csv") {
  const form = new FormData();
  form.append("file", new Blob([content], { type }), filename);
  const req = new Request("http://orbita.test/upload", { method: "POST", body: form });
  return {
    headers: { "content-type": req.headers.get("content-type") },
    body: Buffer.from(await req.arrayBuffer()),
  };
}

async function validate(filename, content = "a,b\n1,2\n", type = "text/csv") {
  return validateCsvUpload(await multipart(filename, content, type));
}

describe("upload safety validator", () => {
  it("accepts a tiny valid CSV", async () => {
    const result = await validate("measurements.csv");
    assert.equal(result.ok, true);
    assert.equal(result.rowCount, 2);
  });

  it("rejects path traversal and absolute filenames", async () => {
    for (const name of ["../evil.csv", "..\\evil.csv", "/tmp/evil.csv", "C:\\evil.csv"]) {
      const result = await validate(name);
      assert.equal(result.ok, false, `${name} must be rejected`);
      assert.equal(result.status, 400);
    }
  });

  it("rejects executable, script, archive, and double-extension filenames", async () => {
    for (const name of ["evil.exe", "evil.csv.exe", "evil.zip", "evil.sh", "evil.js", "evil.exe.csv"]) {
      const result = await validate(name);
      assert.equal(result.ok, false, `${name} must be rejected`);
      assert.equal(result.status, 400);
    }
  });

  it("rejects unsupported MIME types even when the extension is .csv", async () => {
    const result = await validate("evil.csv", "a,b\n1,2\n", "application/x-msdownload");
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  });

  it("rejects binary/archive/script content hidden behind .csv", async () => {
    const cases = [
      Buffer.from([0x4d, 0x5a, 0x00, 0x01]),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
      "#!/bin/sh\necho nope\n",
      "<script>alert(1)</script>\n",
    ];
    for (const content of cases) {
      const result = await validate("looks.csv", content, "text/csv");
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
    }
  });

  it("rejects oversized multipart bodies", async () => {
    const payload = await multipart("big.csv", Buffer.alloc(MAX_CSV_UPLOAD_BYTES + 1, "a"));
    const result = validateCsvUpload(payload);
    assert.equal(result.ok, false);
    assert.equal(result.status, 413);
  });
});
