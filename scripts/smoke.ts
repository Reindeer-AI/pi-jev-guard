import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { Guard, GuardError } from "../src/guard.ts";
import { canonical, parseConfig, Policy, splitFrontmatter } from "../src/policy.ts";

if (!process.env.TYPESAFE_API_KEY) throw new Error("Set TYPESAFE_API_KEY before running the live smoke test");
const root = await canonical(await mkdtemp(join(tmpdir(), "jev-guard-smoke-")));
try {
  const template = await readFile(new URL("../policy.md", import.meta.url), "utf8");
  const bundled = parseConfig(template);
  const configPath = join(root, "policy.md");
  const config = { ...bundled, mode: "enforce", timeoutMs: 15000 };
  await mkdir(join(root, ".git"));
  await writeFile(configPath, `---\n${stringify(config)}---\n${template.slice(splitFrontmatter(template).bodyStart)}`);
  const instructions = join(root, "AGENTS.md");
  await writeFile(instructions, "# Repository instructions\n\nDo not use console.log in application source code.\n");
  const target = join(root, "example.ts");
  await writeFile(target, "export const value = 1;\n");
  const guard = new Guard(await Policy.load(configPath, root));
  const safe = "export const value = 2;\n";
  const allowed = await guard.mutate(target, safe, (path) => writeFile(path, safe));
  assert.equal(allowed.status, "pass");
  console.log(JSON.stringify({ scenario: "allowed", status: allowed.status, elapsedMs: allowed.elapsedMs, model: allowed.model }));
  const unsafe = 'console.log("synthetic smoke test");\n';
  await assert.rejects(guard.mutate(target, unsafe, (path) => writeFile(path, unsafe)), (error: GuardError) => {
    assert(error instanceof GuardError);
    assert.equal(error.report.status, "violation");
    assert(error.report.violations.some((finding) => finding.source === instructions
      && finding.text === "Do not use console.log in application source code."));
    console.log(JSON.stringify({ scenario: "blocked-by-repository-instructions", status: error.report.status,
      elapsedMs: error.report.elapsedMs, violations: error.report.violations.map(({ lines, probability }) => ({ lines, probability })) }));
    return true;
  });
  assert.equal(await readFile(target, "utf8"), safe);
} finally {
  await rm(root, { recursive: true, force: true });
}
