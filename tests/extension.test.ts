import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { GuardError } from "../src/guard.ts";
import type { JevRequest } from "../src/jev.ts";
import { fetcher, fixture, reply } from "./helpers.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
async function harness(configPath: string, cwd: string) {
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, Handler>();
  const entries: unknown[] = [];
  const api = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerFlag: () => {},
    getFlag: () => configPath,
    on: (event: string, handler: Handler) => events.set(event, handler),
    registerCommand: () => {},
    appendEntry: (_type: string, value: unknown) => entries.push(value),
  } as unknown as ExtensionAPI;
  extension(api);
  const ctx = { cwd, hasUI: false, isProjectTrusted: () => true } as ExtensionContext;
  await events.get("session_start")!({}, ctx);
  return {
    entries,
    call: (name: string, input: unknown) => tools.get(name)!.execute("test-call", input as never, undefined, undefined, ctx),
  };
}

function mockService(t: TestContext, handler: (request: JevRequest) => Promise<Response> | Response) {
  const previous = globalThis.fetch;
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-only-typesafe-credential";
  globalThis.fetch = fetcher(handler);
  t.after(() => {
    globalThis.fetch = previous;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  });
}

test("real built-in multi-edit semantics, BOM, CRLF, and diff details survive the wrapper", async (t) => {
  const f = await fixture({ mode: "enforce" }); t.after(f.cleanup);
  const before = "\uFEFFconst a = 1;\r\nconst b = 2;\r\n";
  await writeFile(f.target, before);
  let sent: JevRequest | undefined;
  mockService(t, (request) => { sent = request; return reply(request); });
  const h = await harness(f.config, f.root);
  const result = await h.call("edit", { path: f.target, edits: [
    { oldText: "const a = 1;", newText: "const a = 3;" },
    { oldText: "const b = 2;", newText: "const b = 4;" },
  ] });
  assert.equal(sent!.state.edit.before, before);
  assert.equal(sent!.state.edit.after, "\uFEFFconst a = 3;\r\nconst b = 4;\r\n");
  assert.equal(await readFile(f.target, "utf8"), sent!.state.edit.after);
  assert.match((result.details as { diff: string }).diff, /const a = 3/);
  assert.match(JSON.stringify(result.content), /jev/);
});

test("invalid multi-edits fail before review and preserve the file", async (t) => {
  const f = await fixture({ mode: "enforce" }); t.after(f.cleanup);
  mockService(t, () => assert.fail("invalid edits must not reach Jev"));
  const h = await harness(f.config, f.root);
  await assert.rejects(h.call("edit", { path: f.target, edits: [
    { oldText: "const value = 1;", newText: "new" },
    { oldText: "value", newText: "other" },
  ] }), /overlap/i);
  assert.equal(await readFile(f.target, "utf8"), "const value = 1;\n");
});

test("new-file enforcement creates neither the file nor parent directories", async (t) => {
  const f = await fixture({ mode: "enforce" }); t.after(f.cleanup);
  mockService(t, (request) => reply(request, 0.99));
  const h = await harness(f.config, f.root);
  const path = join(f.root, "not-created", "src.ts");
  await assert.rejects(h.call("write", { path, content: "console.log(password);" }), GuardError);
  await assert.rejects(access(join(f.root, "not-created")), { code: "ENOENT" });
  assert.equal(h.entries.length, 1);
  assert.equal(JSON.stringify(h.entries).includes("password"), false);
});

test("informative findings reach the caller without marking the successful edit as failed", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  mockService(t, (request) => reply(request, 0.99));
  const h = await harness(f.config, f.root);
  const result = await h.call("write", { path: f.target, content: "console.log(password);" });
  const last = result.content.at(-1)!;
  assert.equal(last.type, "text");
  const report = JSON.parse((last as { text: string }).text).jev;
  assert.equal(report.status, "violation");
  assert.equal(report.applied, true);
  assert.equal(report.violations[0].text, "Do not log passwords.");
  assert.equal(await readFile(f.target, "utf8"), "console.log(password);");
});

test("parallel same-file calls serialize read, review, and write through Pi's mutation queue", async (t) => {
  const f = await fixture({ mode: "enforce" }); t.after(f.cleanup);
  await writeFile(f.target, "const a = 1;\nconst b = 2;\n");
  const befores: Array<string | null> = [];
  mockService(t, async (request) => {
    befores.push(request.state.edit.before);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return reply(request);
  });
  const h = await harness(f.config, f.root);
  await Promise.all([
    h.call("edit", { path: f.target, edits: [{ oldText: "a = 1", newText: "a = 3" }] }),
    h.call("edit", { path: f.target, edits: [{ oldText: "b = 2", newText: "b = 4" }] }),
  ]);
  assert.equal(befores.length, 2);
  assert.equal(befores[1], "const a = 3;\nconst b = 2;\n");
  assert.equal(await readFile(f.target, "utf8"), "const a = 3;\nconst b = 4;\n");
});

test("broken startup configuration never silently disables the guard", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await writeFile(f.config, "invalid config");
  mockService(t, () => assert.fail("must not call Jev"));
  const h = await harness(f.config, f.root);
  await assert.rejects(h.call("write", { path: f.target, content: "new" }), /unavailable/);
  assert.equal(await readFile(f.target, "utf8"), "const value = 1;\n");
});
