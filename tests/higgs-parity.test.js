import test from "node:test";
import assert from "node:assert/strict";
import { main, parseDuration } from "../src/cli.js";

// ------------------------------------------------------------------ parseDuration (higgsfield 10m/3s)
test("parseDuration: понимает 10m, 3s, 600", () => {
  assert.equal(parseDuration("10m", 600), 600);
  assert.equal(parseDuration("3s", 5), 3);
  assert.equal(parseDuration("600", 600), 600);
  assert.equal(parseDuration("0.5m", 0), 30);
  assert.throws(() => parseDuration("bad", 0), /Неверный формат/);
});

// ------------------------------------------------------------------ higgs parity aliases (без сети, dry-run)
test("model list --json (higgs alias) — count >0", async () => {
  let out = "";
  const origLog = console.log;
  console.log = (s) => { out += s + "\n"; };
  const code = await main(["model", "list", "--json"]);
  console.log = origLog;
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.ok(data.count > 0);
  assert.ok(Array.isArray(data.models));
});

test("model list --video --json — только video", async () => {
  let out = "";
  const origLog = console.log;
  console.log = (s) => { out += s + "\n"; };
  const code = await main(["model", "list", "--video", "--json"]);
  console.log = origLog;
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.ok(data.models.every((m) => m.category === "video"));
});

test("model get --json — схема", async () => {
  let out = "";
  const origLog = console.log;
  console.log = (s) => { out += s + "\n"; };
  const code = await main(["model", "get", "google/nano-banana", "--json"]);
  console.log = origLog;
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.equal(data.id, "google/nano-banana");
  assert.ok(Array.isArray(data.fields));
});

test("generate create --dry-run --json (higgs alias) — не требует ключа", async () => {
  let out = "";
  const origLog = console.log;
  console.log = (s) => { out += s + "\n"; };
  const code = await main(["generate", "create", "google/nano-banana", "--prompt", "test", "--dry-run", "--json"]);
  console.log = origLog;
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.equal(data.dryRun, true);
  assert.equal(data.model, "google/nano-banana");
});

test("cost --json — pricing без создания задачи", async () => {
  let out = "";
  const origLog = console.log;
  console.log = (s) => { out += s + "\n"; };
  const code = await main(["cost", "google/nano-banana", "--prompt", "test", "--json"]);
  console.log = origLog;
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.equal(data.model, "google/nano-banana");
  assert.ok(data.pricing || data.note);
});

test("generate cost --json (alias) — то же что cost", async () => {
  let out = "";
  const origLog = console.log;
  console.log = (s) => { out += s + "\n"; };
  const code = await main(["generate", "cost", "google/nano-banana", "--prompt", "test", "--json"]);
  console.log = origLog;
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.equal(data.model, "google/nano-banana");
});

test("workflow list --json", async () => {
  let out = "";
  const origLog = console.log;
  console.log = (s) => { out += s + "\n"; };
  const code = await main(["workflow", "list", "--json"]);
  console.log = origLog;
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.ok(data.workflows.length >= 4);
});

test("generate list --json — история", async () => {
  let out = "";
  const origLog = console.log;
  console.log = (s) => { out += s + "\n"; };
  const code = await main(["generate", "list", "--json"]);
  console.log = origLog;
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.ok(typeof data.count === "number");
  assert.ok(Array.isArray(data.jobs));
});

test("run --wait-timeout 1m alias — принимает 1m", async () => {
  // dry-run + wait-timeout не должен падать на парсинге, но wait не триггерит сеть в dry-run
  let out = "";
  const origLog = console.log;
  console.log = (s) => { out += s + "\n"; };
  const code = await main(["generate", "create", "google/nano-banana", "--prompt", "test", "--dry-run", "--json", "--wait-timeout", "1m"]);
  console.log = origLog;
  // dry-run игнорирует wait, просто проверяет что флаг распарсился
  assert.equal(code, 0);
});
