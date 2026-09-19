import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { Config } from "../src/policy.ts";
import { canonical, parseConfig, Policy } from "../src/policy.ts";
import type { JevRequest } from "../src/jev.ts";

export const defaultText = await readFile(new URL("../policy.md", import.meta.url), "utf8");
export const defaults = parseConfig(defaultText);
export const rules = "# Rules\n\nDo not log passwords.\n\nUse structured logging.\n";
export const configText = (overrides: Partial<Config> = {}) => `---\n${stringify({ ...defaults, ruleFiles: ["rules.md"], ...overrides })}---\n# Config\n\n## Rules\n`;

export async function fixture(overrides: Partial<Config> = {}) {
  const root = await canonical(await mkdtemp(join(tmpdir(), "jev-guard-test-")));
  await mkdir(join(root, ".git"));
  const config = join(root, "policy.md");
  await writeFile(config, configText(overrides));
  await writeFile(join(root, "rules.md"), rules);
  const target = join(root, "src.ts");
  await writeFile(target, "const value = 1;\n");
  const policy = await Policy.load(config, root);
  return { root, config, target, policy, cleanup: () => rm(root, { recursive: true, force: true }) };
}
export function reply(request: JevRequest, probability = 0.01) {
  return Response.json({
    model: "jev-1.13.0",
    answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: probability }])),
    usage: { input_tokens: 100, output_tokens: 2 },
  });
}
export function fetcher(handler: (request: JevRequest, init: RequestInit) => Promise<Response> | Response): typeof fetch {
  return async (_url, init) => handler(JSON.parse(String(init?.body)), init!);
}
