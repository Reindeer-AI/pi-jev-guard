import assert from "node:assert/strict";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { digest, isSensitive, parseBlocks, parseConfig, Policy } from "../src/policy.ts";
import { configText, defaults, fixture } from "./helpers.ts";

test("config validates enums, thresholds, aliases, unknown fields, and filename patterns", () => {
  assert.equal(parseConfig(configText()).model, "jev-1.13.0");
  assert.throws(() => parseConfig(configText().replace("mode: informative", "mode: typo")), /mode/);
  assert.throws(() => parseConfig(configText({ clearThreshold: 0.9 })), /below/);
  assert.throws(() => parseConfig(configText().replace("mode: informative", "mode: informative\nmode: enforce")), /YAML/);
  assert.throws(() => parseConfig(configText().replace("mode: informative", "mode: informative\nendpoint: https:\/\/example.com")), /Unknown/);
  assert.throws(() => parseConfig(configText({ instructionPatterns: ["**/AGENTS.md"] })), /filenames/);
  assert.throws(() => parseConfig(configText({ timeoutMs: 0 })), /timeoutMs/);
  assert.throws(() => parseConfig("not frontmatter"), /frontmatter/);
});

test("Markdown spans retain original positions, context, and entire nested list rules", () => {
  const source = "# Instructions\r\n\r\n- First requirement.\r\n  - Its exception.\r\n\r\nParagraph rule.\r\n\r\n```ts\r\n// Example, not another rule.\r\n```\r\n";
  const blocks = parseBlocks(source);
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks.filter((b) => b.rule).map((b) => b.lines), [[3, 4], [6, 6]]);
  assert.equal(blocks[1].text, "- First requirement.\r\n  - Its exception.");
  assert.equal(blocks[3].rule, false);
});

test("config metadata and preamble are not rules; body line numbers remain original", () => {
  const source = configText() + "\n- Avoid swallowing errors.\n";
  const blocks = parseBlocks(source, true);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "- Avoid swallowing errors.");
  assert.equal(blocks[0].lines[0], source.split("\n").findIndex((line) => line.startsWith("- Avoid")) + 1);
});

test("discovers only applicable ancestors in root-to-leaf order with configurable casing", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await mkdir(join(f.root, "a", "b"), { recursive: true });
  await mkdir(join(f.root, "sibling"));
  await writeFile(join(f.root, "agents.md"), "Root rule.");
  await writeFile(join(f.root, "a", "CLAUDE.md"), "Local rule.");
  await writeFile(join(f.root, "sibling", "AGENTS.md"), "Not applicable.");
  const snapshot = await f.policy.collect(join(f.root, "a", "b", "new.ts"));
  assert.deepEqual(snapshot.documents.map((doc) => doc.source.replace(f.root + "/", "")), ["policy.md", "rules.md", "agents.md", "a/CLAUDE.md"]);
  await writeFile(f.config, configText({ caseSensitive: true }));
  const strict = await Policy.load(f.config, f.root);
  const strictSnapshot = await strict.collect(join(f.root, "a", "b", "new.ts"));
  assert.equal(strictSnapshot.documents.some((doc) => doc.source.endsWith("/agents.md")), false);
});

test("instruction discovery uses the edited repository, not the config directory", async (t) => {
  const repository = await fixture(); t.after(repository.cleanup);
  const extension = await fixture(); t.after(extension.cleanup);
  await writeFile(join(repository.root, "AGENTS.md"), "Repository-owned rule.\n");
  await writeFile(join(extension.root, "AGENTS.md"), "Not a rule for the edited repository.\n");
  const policy = await Policy.load(extension.config, repository.root);
  const snapshot = await policy.collect(repository.target);
  assert(snapshot.documents.some((doc) => doc.source === join(repository.root, "AGENTS.md")));
  assert(!snapshot.documents.some((doc) => doc.source === join(extension.root, "AGENTS.md")));
});

test("fresh content, new instructions, and the config itself invalidate a snapshot", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const first = await f.policy.collect(f.target);
  await writeFile(join(f.root, "AGENTS.md"), "New rule.");
  const second = await f.policy.collect(f.target);
  assert.notEqual(first.fingerprint, second.fingerprint);
  await writeFile(join(f.root, "AGENTS.md"), "Another rule.");
  assert.notEqual(second.fingerprint, (await f.policy.collect(f.target)).fingerprint);
  await writeFile(f.config, configText({ mode: "enforce" }));
  await assert.rejects(f.policy.collect(f.target), /config changed/);
});

test("scope, explicit missing rules, and instruction symlink escapes are not silently accepted", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const other = await fixture(); t.after(other.cleanup);
  await assert.rejects(f.policy.collect(other.target), /outside/);
  await symlink(other.target, join(f.root, "AGENTS.md"));
  await assert.rejects(f.policy.collect(f.target), /symlink/);
  await unlink(join(f.root, "AGENTS.md"));
  await writeFile(f.config, configText({ ruleFiles: ["missing.md"] }));
  const missing = await Policy.load(f.config, f.root);
  await assert.rejects(missing.collect(f.target), /ENOENT/);
});

test("code globs, sensitive paths, and protected policy paths", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  assert.equal(f.policy.code(f.target), true);
  for (const path of ["README.md", "node_modules/a.ts", "x.generated.ts", ".env", "keys.pem"]) {
    assert.equal(f.policy.code(join(f.root, path)), false, path);
  }
  assert.equal(await f.policy.protected(f.config), true);
  assert.equal(await f.policy.protected(join(f.root, "rules.md")), true);
  assert.equal(await f.policy.protected(join(f.root, "AGENTS_README.md")), true);
  assert.equal(isSensitive("/a/.env.prod"), true);
  assert.equal(isSensitive("/a/.ssh/id_ed25519"), true);
});

test("retargeted explicit rule symlinks refresh snapshots and protected targets", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const link = join(f.root, "rules.md");
  const first = join(f.root, "first.md");
  const second = join(f.root, "second.md");
  await writeFile(first, "First policy.\n");
  await writeFile(second, "Second policy.\n");
  await unlink(link);
  await symlink(first, link);
  const before = await f.policy.collect(f.target);
  await unlink(link);
  await symlink(second, link);
  const after = await f.policy.collect(f.target);
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.equal(after.documents[1].source, link);
  assert.equal(after.documents[1].canonicalSource, second);
  assert.equal(after.documents[1].blocks[0].text, "Second policy.");
  assert.equal(await f.policy.protected(second), true);
});

test("document byte limits reject rather than truncate and snapshot hashes cover original bytes", async (t) => {
  const f = await fixture({ maxDocumentBytes: 2000 }); t.after(f.cleanup);
  const snapshot = await f.policy.collect(f.target);
  assert.equal(snapshot.documents[1].sha256, digest(await readFile(join(f.root, "rules.md"), "utf8")));
  await writeFile(join(f.root, "rules.md"), "x".repeat(2001));
  await assert.rejects(f.policy.collect(f.target), /maxDocumentBytes/);
  assert(defaults.maxRequestBytes > defaults.maxStateBytes);
});
