"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

// auth.js has no DB dependency — pure unit tests
const auth = require("../lib/auth.js");

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    assert.equal(auth.normalizeEmail("  Alice@Example.COM  "), "alice@example.com");
  });
  it("handles empty string", () => {
    assert.equal(auth.normalizeEmail(""), "");
  });
  it("handles null/undefined", () => {
    assert.equal(auth.normalizeEmail(null),      "");
    assert.equal(auth.normalizeEmail(undefined),  "");
  });
});

describe("normalizeUsername", () => {
  it("lowercases and trims", () => {
    assert.equal(auth.normalizeUsername("  Derek  "), "derek");
  });
  it("handles empty string", () => {
    assert.equal(auth.normalizeUsername(""), "");
  });
});

describe("validateSignupInput", () => {
  const valid = {
    email:           "test@example.com",
    username:        "tester01",
    password:        "StrongPass1234",
    confirmPassword: "StrongPass1234",
  };

  it("returns no errors for valid input", () => {
    assert.deepEqual(auth.validateSignupInput(valid), []);
  });

  it("rejects missing email", () => {
    const errors = auth.validateSignupInput({ ...valid, email: "" });
    assert.ok(errors.some(e => /email/i.test(e)));
  });

  it("rejects malformed email", () => {
    const errors = auth.validateSignupInput({ ...valid, email: "notanemail" });
    assert.ok(errors.some(e => /email/i.test(e)));
  });

  it("rejects short username", () => {
    const errors = auth.validateSignupInput({ ...valid, username: "ab" });
    assert.ok(errors.some(e => /username/i.test(e)));
  });

  it("rejects username with illegal characters", () => {
    const errors = auth.validateSignupInput({ ...valid, username: "hello world!" });
    assert.ok(errors.some(e => /username/i.test(e)));
  });

  it("rejects username that is too long", () => {
    const errors = auth.validateSignupInput({ ...valid, username: "a".repeat(31) });
    assert.ok(errors.some(e => /username/i.test(e)));
  });

  it("rejects password shorter than MIN_PASSWORD_LENGTH", () => {
    const short = "short";
    assert.ok(short.length < auth.MIN_PASSWORD_LENGTH);
    const errors = auth.validateSignupInput({ ...valid, password: short, confirmPassword: short });
    assert.ok(errors.some(e => /password/i.test(e)));
  });

  it("rejects mismatched passwords", () => {
    const errors = auth.validateSignupInput({ ...valid, confirmPassword: "DifferentPass99" });
    assert.ok(errors.some(e => /match/i.test(e)));
  });

  it("accumulates multiple errors", () => {
    const errors = auth.validateSignupInput({ email: "", username: "", password: "", confirmPassword: "x" });
    assert.ok(errors.length >= 2);
  });
});

describe("hashPassword / verifyPassword", () => {
  it("produces a bcrypt hash that verifies correctly", async () => {
    const hash = await auth.hashPassword("MySecurePass123");
    assert.ok(typeof hash === "string");
    assert.ok(hash.startsWith("$2"));
    assert.ok(await auth.verifyPassword("MySecurePass123", hash));
  });

  it("rejects wrong password", async () => {
    const hash = await auth.hashPassword("CorrectHorse1234");
    assert.equal(await auth.verifyPassword("WrongPassword1234", hash), false);
  });
});

describe("hashInviteCode", () => {
  it("returns a 64-char hex string (SHA-256)", () => {
    const h = auth.hashInviteCode("some-invite-token");
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]+$/);
  });

  it("trims whitespace before hashing", () => {
    const a = auth.hashInviteCode("code");
    const b = auth.hashInviteCode("  code  ");
    assert.equal(a, b);
  });

  it("different codes produce different hashes", () => {
    const a = auth.hashInviteCode("code-one");
    const b = auth.hashInviteCode("code-two");
    assert.notEqual(a, b);
  });
});

describe("safeHexEqual", () => {
  it("returns true for equal hex strings", () => {
    const h = auth.hashInviteCode("test");
    assert.ok(auth.safeHexEqual(h, h));
  });

  it("returns false for different hex strings", () => {
    const a = auth.hashInviteCode("code-a");
    const b = auth.hashInviteCode("code-b");
    assert.equal(auth.safeHexEqual(a, b), false);
  });

  it("returns false when either argument is empty", () => {
    assert.equal(auth.safeHexEqual("", auth.hashInviteCode("x")), false);
    assert.equal(auth.safeHexEqual(auth.hashInviteCode("x"), ""), false);
  });
});

describe("CSRF tokens", () => {
  it("generateCsrfToken returns a 64-char hex string", () => {
    const t = auth.generateCsrfToken();
    assert.equal(t.length, 64);
    assert.match(t, /^[0-9a-f]+$/);
  });

  it("verifyCsrfToken returns true when token matches session", () => {
    const token   = auth.generateCsrfToken();
    const session = { csrfToken: token };
    assert.ok(auth.verifyCsrfToken(session, token));
  });

  it("verifyCsrfToken returns false for wrong token", () => {
    const session = { csrfToken: auth.generateCsrfToken() };
    assert.equal(auth.verifyCsrfToken(session, auth.generateCsrfToken()), false);
  });

  it("verifyCsrfToken returns false when session has no token", () => {
    assert.equal(auth.verifyCsrfToken({}, auth.generateCsrfToken()), false);
  });

  it("verifyCsrfToken returns false when submitted token is empty", () => {
    const token   = auth.generateCsrfToken();
    const session = { csrfToken: token };
    assert.equal(auth.verifyCsrfToken(session, ""), false);
  });

  it("two generated tokens are different", () => {
    assert.notEqual(auth.generateCsrfToken(), auth.generateCsrfToken());
  });
});
