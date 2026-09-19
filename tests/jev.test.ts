import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRequest, decodeAnswers, JevClient } from "../src/jev.ts";
import { defaults, fetcher, fixture, reply } from "./helpers.ts";

const key = "test-only-typesafe-credential";

test("one HTTP request carries all instructions and returns exact snapshot-bound spans", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const snapshot = await f.policy.collect(f.target);
  let calls = 0;
  const client = new JevClient(fetcher((request, init) => {
    calls++;
    assert.equal(init.redirect, "error");
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${key}`);
    assert.equal(Object.keys(request.questions).length, 2);
    assert.equal(request.state.documents.length, snapshot.documents.length);
    assert.match(request.questions.d1_b1.instructions, /documents\[1\]\.blocks\[1\]\.text/);
    return reply(request, 0.99);
  }), () => key);
  const result = await client.evaluate(defaults, snapshot, f.target, "before", "after");
  assert.equal(calls, 1);
  assert.equal(result.violations.length, 2);
  assert.deepEqual(result.violations[0], {
    source: snapshot.documents[1].source, snapshot: snapshot.documents[1].sha256,
    lines: [3, 3], text: "Do not log passwords.", probability: 0.99,
  });
});

test("strict answer validation rejects missing, invented, malformed, and out-of-range verdicts", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const request = buildRequest(defaults, await f.policy.collect(f.target), f.target, "a", "b");
  const good = await reply(request).json();
  assert.equal(decodeAnswers(good, request, defaults).violations.length, 0);
  for (const value of [null, {}, { ...good, answers: {} }, { ...good, answers: { ...good.answers, invented: { type: "noul", noul: 1 } } }]) {
    assert.throws(() => decodeAnswers(value, request, defaults));
  }
  for (const answer of [null, { type: "choice", noul: 1 }, { type: "noul", noul: -1 }, { type: "noul", noul: 2 }, { type: "noul", noul: NaN }]) {
    const value = structuredClone(good);
    value.answers[Object.keys(request.questions)[0]] = answer;
    assert.throws(() => decodeAnswers(value, request, defaults), /verdict/);
  }
});

test("pinned response model mismatches are rejected while aliases can resolve to a version", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const request = buildRequest(defaults, await f.policy.collect(f.target), f.target, "a", "b");
  const response = await reply(request).json();
  assert.throws(() => decodeAnswers({ ...response, model: "jev-2.0.0" }, request, defaults), /pinned request/);
  assert.doesNotThrow(() => decodeAnswers(response, { ...request, model: "jev-latest" }, defaults));
});

test("cache is keyed by code, instructions, and model; only complete valid results are cached", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const snapshot = await f.policy.collect(f.target);
  let calls = 0;
  const client = new JevClient(fetcher((request) => { calls++; return reply(request, 0.5); }), () => key);
  const first = await client.evaluate(defaults, snapshot, f.target, "a", "b");
  assert.equal(first.uncertain.length, 2);
  assert.equal(first.cached, false);
  assert.equal((await client.evaluate(defaults, snapshot, f.target, "a", "b")).cached, true);
  await client.evaluate(defaults, snapshot, f.target, "a", "c");
  await client.evaluate({ ...defaults, model: "jev-latest" }, snapshot, f.target, "a", "b");
  assert.equal(calls, 3);
});

test("missing credentials, empty rules, byte budgets, and detected secrets prevent network requests", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const snapshot = await f.policy.collect(f.target);
  const noNetwork: typeof fetch = async () => { throw new Error("unexpected network call"); };
  const client = new JevClient(noNetwork, () => key);
  await assert.rejects(new JevClient(noNetwork, () => undefined).evaluate(defaults, snapshot, f.target, "a", "b"), /not set/);
  await assert.rejects(client.evaluate(defaults, { documents: [], fingerprint: "" }, f.target, "a", "b"), /No rule/);
  await assert.rejects(client.evaluate({ ...defaults, maxStateBytes: 1 }, snapshot, f.target, "a", "b"), /maxStateBytes/);
  await assert.rejects(client.evaluate({ ...defaults, maxRequestBytes: 1 }, snapshot, f.target, "a", "b"), /maxRequestBytes/);
  await assert.rejects(client.evaluate(defaults, snapshot, f.target, "a", key), /Sensitive/);
  await assert.rejects(client.evaluate(defaults, snapshot, f.target, "a", "-----BEGIN PRIVATE KEY-----"), /Sensitive/);
});

test("HTTP failures never echo response bodies or retry indefinitely", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const snapshot = await f.policy.collect(f.target);
  for (const status of [401, 422, 429, 529]) {
    let calls = 0;
    const client = new JevClient(async () => { calls++; return new Response(key, { status }); }, () => key);
    await assert.rejects(client.evaluate(defaults, snapshot, f.target, "a", "b"), (error: Error) => {
      assert.equal(error.message, `Jev returned HTTP ${status}`);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("timeouts and user cancellation abort the request", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const snapshot = await f.policy.collect(f.target);
  const stall: typeof fetch = async (_url, init) => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("test did not abort")), 1000);
    init!.signal!.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
  const client = new JevClient(stall, () => key);
  await assert.rejects(client.evaluate({ ...defaults, timeoutMs: 10 }, snapshot, f.target, "a", "b"), /timed out/);
  const abort = new AbortController();
  const running = client.evaluate(defaults, snapshot, f.target, "a", "b", abort.signal);
  abort.abort();
  await assert.rejects(running, { name: "AbortError" });
});
