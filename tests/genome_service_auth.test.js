"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  allowedUserSet,
  bearerMatches,
  coreTenantId,
  createGenomeServiceAuth,
} = require("../lib/genomeServiceAuth");

it("coreTenantId matches the Guided core UUID tenant boundary", () => {
  assert.equal(
    coreTenantId("9e6c186e-6c49-4775-bcad-050d01685968"),
    "g-1894b8d0f97baf6037cacd0b6f4098c0",
  );
});

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

describe("Discovery Genome service authentication", () => {
  it("normalizes and allowlists explicit usernames", () => {
    assert.deepEqual([...allowedUserSet(" Derek,SECOND_USER ,,")], ["derek", "second_user"]);
  });

  it("compares bearer tokens without accepting prefixes or unequal lengths", () => {
    const token = "a".repeat(48);
    assert.equal(bearerMatches(`Bearer ${token}`, token), true);
    assert.equal(bearerMatches(token, token), false);
    assert.equal(bearerMatches("Bearer short", token), false);
  });

  it("resolves only an active allowlisted tenant and never accepts a UUID header", async () => {
    const user = { id: "user-1", username: "Derek", status: "active" };
    const db = {
      async query(sql, values) {
        assert.match(sql, /lower\(username\)/);
        assert.deepEqual(values, ["derek"]);
        return { rows: [user] };
      },
    };
    const middleware = createGenomeServiceAuth({
      db,
      token: "t".repeat(48),
      allowedUsers: "Derek",
    });
    const req = {
      user: null,
      get(name) {
        if (name === "authorization") return `Bearer ${"t".repeat(48)}`;
        if (name === "x-orbita-genome-user") return "DEREK";
        if (name === "x-orbita-user-id") return "attacker-chosen-uuid";
        return "";
      },
    };
    const res = response();
    let called = false;
    await middleware(req, res, () => { called = true; });
    assert.equal(called, true);
    assert.equal(req.user.id, "user-1");
  });

  it("fails closed when the service token is absent", async () => {
    const middleware = createGenomeServiceAuth({
      db: { query: async () => ({ rows: [] }) },
      token: "",
      allowedUsers: "derek",
    });
    const res = response();
    await middleware({ get: () => "" }, res, () => assert.fail("must not continue"));
    assert.equal(res.statusCode, 503);
  });
});
