"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const email = require("../lib/email");
const emailVerification = require("../lib/emailVerification");

const OLD_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in OLD_ENV)) delete process.env[key];
  }
  Object.assign(process.env, OLD_ENV);
  email._resetResendClientForTest();
}

function loadTokensWithMockDb(fakeDb) {
  const dbPath = require.resolve("../lib/db");
  const tokensPath = require.resolve("../lib/tokens");
  const previousDb = require.cache[dbPath];
  const previousTokens = require.cache[tokensPath];

  delete require.cache[tokensPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: fakeDb,
  };

  const loadedTokens = require("../lib/tokens");
  return {
    tokens: loadedTokens,
    restore() {
      delete require.cache[tokensPath];
      if (previousDb) require.cache[dbPath] = previousDb;
      else delete require.cache[dbPath];
      if (previousTokens) require.cache[tokensPath] = previousTokens;
    },
  };
}

describe("verification email templates", () => {
  beforeEach(resetEnv);
  afterEach(resetEnv);

  it("uses the token-consuming /auth/verify-email route", () => {
    process.env.APP_BASE_URL = "https://staging.safeusi.com/";
    const msg = email.verificationEmail("alice", "tok_secret");
    assert.match(msg.text, /https:\/\/staging\.safeusi\.com\/auth\/verify-email\?token=tok_secret/);
    assert.doesNotMatch(msg.text, /https:\/\/staging\.safeusi\.com\/verify-email\?token=tok_secret/);
  });

  it("does not mark staging email as sent when delivery is unconfigured", async () => {
    process.env.APP_ENV = "staging";
    delete process.env.RESEND_API_KEY;
    process.env.EMAIL_FROM = "Orbita <noreply@example.com>";
    process.env.APP_BASE_URL = "https://staging.safeusi.com";

    const result = await email.sendEmail({
      to: "user@example.com",
      subject: "Verify",
      html: "<p>Verify</p>",
      text: "Verify",
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "missing_api_key");
  });

  it("returns provider success only when Resend accepts the message", async () => {
    process.env.APP_ENV = "staging";
    process.env.RESEND_API_KEY = "re_test_fake_key_for_unit_tests";
    process.env.EMAIL_FROM = "Orbita <noreply@example.com>";
    process.env.APP_BASE_URL = "https://staging.safeusi.com";

    const result = await email.sendEmail({
      to: "user@example.com",
      subject: "Verify",
      html: "<p>Verify</p>",
      text: "Verify",
      client: { emails: { send: async () => ({ data: { id: "email_123" }, error: null }) } },
    });

    assert.equal(result.ok, true);
    assert.equal(result.accepted, true);
    assert.equal(result.id, "email_123");
  });

  it("returns provider failure instead of false success", async () => {
    process.env.APP_ENV = "staging";
    process.env.RESEND_API_KEY = "re_test_fake_key_for_unit_tests";
    process.env.EMAIL_FROM = "Orbita <noreply@example.com>";
    process.env.APP_BASE_URL = "https://staging.safeusi.com";

    const result = await email.sendEmail({
      to: "user@example.com",
      subject: "Verify",
      html: "<p>Verify</p>",
      text: "Verify",
      client: {
        emails: {
          send: async () => ({
            data: null,
            error: { message: "sender domain is not verified", statusCode: 403 },
          }),
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.accepted, false);
    assert.equal(result.statusCode, 403);
    assert.match(result.error, /sender domain/);
  });
});

describe("deliverVerificationEmail", () => {
  beforeEach(resetEnv);
  afterEach(resetEnv);

  it("creates a token, sends it, and does not return the raw token", async () => {
    const calls = [];
    const result = await emailVerification.deliverVerificationEmail({
      userId: "user_1",
      username: "alice",
      email: "alice@example.com",
      action: "signup",
      tokenStore: {
        createVerificationToken: async userId => {
          calls.push(["token", userId]);
          return "raw_secret_token";
        },
      },
      mailer: {
        verificationEmail: (username, token) => {
          calls.push(["template", username, token]);
          return { subject: "Verify", html: "<p>Verify</p>", text: `token ${token}` };
        },
        verificationUrl: token => `https://staging.safeusi.com/auth/verify-email?token=${token}`,
        getEmailConfig: () => ({ provider: "resend", fromDomain: "example.com" }),
        sendEmail: async payload => {
          calls.push(["send", payload.subject, payload.text]);
          return { ok: true, provider: "resend", id: "email_123", statusCode: 202, accepted: true };
        },
      },
      logger: { log() {}, error() {} },
    });

    assert.deepEqual(calls[0], ["token", "user_1"]);
    assert.deepEqual(calls[1], ["template", "alice", "raw_secret_token"]);
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes("raw_secret_token"), false);
  });

  it("returns failure and logs a staging fallback URL only outside production", async () => {
    process.env.APP_ENV = "staging";
    const logs = [];
    const result = await emailVerification.deliverVerificationEmail({
      userId: "user_2",
      username: "bob",
      email: "bob@example.com",
      action: "resend",
      tokenStore: { createVerificationToken: async () => "fallback_token" },
      mailer: {
        verificationEmail: () => ({ subject: "Verify", html: "<p>Verify</p>", text: "Verify" }),
        verificationUrl: token => `https://staging.safeusi.com/auth/verify-email?token=${token}`,
        getEmailConfig: () => ({ provider: "resend", fromDomain: "example.com" }),
        sendEmail: async () => ({ ok: false, provider: "resend", error: "forbidden", statusCode: 403 }),
      },
      logger: { log: msg => logs.push(msg), error: msg => logs.push(msg) },
    });

    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("fallback_token"), false);
    assert.ok(logs.some(line => line.includes("staging_fallback_verification_url")));
    assert.ok(logs.some(line => line.includes("fallback_token")));
  });

  it("does not log fallback verification URLs in production", async () => {
    process.env.APP_ENV = "production";
    const logs = [];
    await emailVerification.deliverVerificationEmail({
      userId: "user_3",
      username: "cara",
      email: "cara@example.com",
      tokenStore: { createVerificationToken: async () => "prod_token" },
      mailer: {
        verificationEmail: () => ({ subject: "Verify", html: "<p>Verify</p>", text: "Verify" }),
        verificationUrl: token => `https://safeusi.com/auth/verify-email?token=${token}`,
        getEmailConfig: () => ({ provider: "resend", fromDomain: "example.com" }),
        sendEmail: async () => ({ ok: false, provider: "resend", error: "forbidden", statusCode: 403 }),
      },
      logger: { log: msg => logs.push(msg), error: msg => logs.push(msg) },
    });

    assert.equal(logs.some(line => line.includes("prod_token")), false);
  });
});

describe("verification token helpers", () => {
  it("creates a single-use token that expires in 24 hours", async () => {
    const queries = [];
    const fakeDb = {
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [] };
      },
    };
    const { tokens, restore } = loadTokensWithMockDb(fakeDb);
    try {
      const before = Date.now();
      const raw = await tokens.createVerificationToken("user_123");
      const after = Date.now();
      const insert = queries.find(q => q.sql.includes("INSERT INTO email_verifications"));
      const expiresAt = insert.params[2].getTime();

      assert.ok(raw.length >= 32);
      assert.ok(queries.some(q => q.sql.includes("DELETE FROM email_verifications")));
      assert.ok(queries.some(q => q.sql.includes("UPDATE users SET verification_sent_at")));
      assert.ok(expiresAt >= before + 24 * 60 * 60_000 - 2_000);
      assert.ok(expiresAt <= after + 24 * 60 * 60_000 + 2_000);
    } finally {
      restore();
    }
  });

  it("rejects expired verification tokens without verifying the user", async () => {
    const calls = [];
    const client = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes("FROM email_verifications")) {
          return {
            rows: [{
              id: "token_1",
              user_id: "user_123",
              expires_at: new Date(Date.now() - 60_000),
              used_at: null,
            }],
          };
        }
        return { rows: [] };
      },
      release() {
        calls.push({ sql: "RELEASE", params: [] });
      },
    };
    const { tokens, restore } = loadTokensWithMockDb({ connect: async () => client });
    try {
      const result = await tokens.consumeVerificationToken("expired_raw_token");
      assert.deepEqual(result, { ok: false, reason: "expired" });
      assert.ok(calls.some(c => c.sql === "ROLLBACK"));
      assert.equal(calls.some(c => c.sql.includes("email_verified_at")), false);
    } finally {
      restore();
    }
  });

  it("valid verification tokens mark the user verified", async () => {
    const calls = [];
    const client = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes("FROM email_verifications")) {
          return {
            rows: [{
              id: "token_1",
              user_id: "user_123",
              expires_at: new Date(Date.now() + 60_000),
              used_at: null,
            }],
          };
        }
        return { rows: [] };
      },
      release() {
        calls.push({ sql: "RELEASE", params: [] });
      },
    };
    const { tokens, restore } = loadTokensWithMockDb({ connect: async () => client });
    try {
      const result = await tokens.consumeVerificationToken("valid_raw_token");
      assert.deepEqual(result, { ok: true, userId: "user_123" });
      assert.ok(calls.some(c => c.sql.includes("UPDATE email_verifications SET used_at")));
      assert.ok(calls.some(c => c.sql.includes("UPDATE users SET email_verified_at")));
      assert.ok(calls.some(c => c.sql === "COMMIT"));
    } finally {
      restore();
    }
  });
});

describe("verify-email UI", () => {
  it("shows a delivery-failure message instead of false success copy", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "verify-email.html"), "utf8");
    assert.match(html, /email_send_failed/);
    assert.match(html, /Account created, but verification email could not be sent/);
  });
});
