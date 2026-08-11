const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const path = require("node:path");

const app = readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const index = readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const styles = readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");

test("Guided UI explains the unified product and routes beginners by job", () => {
  assert.match(index, /Unified Guided \+ MCP core/);
  assert.match(index, /How to use Orbita/);
  assert.match(app, /One Orbita, two ways to use it/);
  assert.match(app, /Analyze one dataset/);
  assert.match(app, /Connect several studies/);
  assert.match(app, /Run a controlled comparison/);
  assert.match(app, /A refusal or an inconclusive result is a valid outcome/);
});

test("Guided UI gives actionable timeout copy and keeps navigation on mobile", () => {
  assert.match(app, /check My cases before trying again/);
  assert.match(app, /New discovery runs may wait in the queue/);
  assert.match(styles, /\.topnav a \{ display: block; flex: 0 0 auto/);
  assert.doesNotMatch(styles, /\.topnav a \{ display: none/);
});
