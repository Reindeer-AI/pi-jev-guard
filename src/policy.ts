import { createHash } from "node:crypto";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { minimatch } from "minimatch";
import { parseDocument } from "yaml";

export type Mode = "informative" | "enforce";
export interface Config {
  mode: Mode;
  model: string;
  instructionPatterns: string[];
  caseSensitive: boolean;
  instructionRoot?: string;
  ruleFiles: string[];
  include: string[];
  exclude: string[];
  violationThreshold: number;
  clearThreshold: number;
  onUnavailable: "block" | "warn";
  onUncertain: "block" | "warn";
  timeoutMs: number;
  maxDocumentBytes: number;
  maxStateBytes: number;
  maxRequestBytes: number;
  cacheTtlMs: number;
}
export interface Block {
  lines: [number, number];
  text: string;
  rule: boolean;
}
export interface Document {
  kind: "configured" | "instructions";
  source: string;
  canonicalSource: string;
  sha256: string;
  blocks: Block[];
}
export interface PolicySnapshot {
  documents: Document[];
  fingerprint: string;
}
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
export const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

const sensitive = [
  "**/.env", "**/.env.*", "**/*.{pem,key,p12,pfx}",
  "**/{.ssh,.aws,.gnupg}/**", "**/{credentials,secrets,auth}.{json,yaml,yml,toml}",
];
export function isSensitive(path: string): boolean {
  return sensitive.some((pattern) => minimatch(path.replaceAll("\\", "/"), pattern, { dot: true, nocase: true }));
}
export async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonical(parent), basename(path));
  }
}
export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
async function boundedRead(path: string, maxBytes: number): Promise<string> {
  if (isSensitive(path)) throw new Error("Sensitive policy files are not sent to Jev");
  if ((await stat(path)).size > maxBytes) throw new Error(`Policy exceeds maxDocumentBytes: ${path}`);
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`Policy exceeds maxDocumentBytes: ${path}`);
  return text;
}
export function splitFrontmatter(text: string): { yaml: string; bodyStart: number } {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("Jev config must begin with YAML frontmatter");
  return { yaml: match[1], bodyStart: match[0].length };
}
export function parseConfig(text: string): Config {
  const doc = parseDocument(splitFrontmatter(text).yaml, { uniqueKeys: true });
  if (doc.errors.length) throw new Error("Invalid Jev config YAML");
  const value = doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Jev config");
  const keys = new Set([
    "mode", "model", "instructionPatterns", "caseSensitive", "instructionRoot", "ruleFiles",
    "include", "exclude", "violationThreshold", "clearThreshold", "onUnavailable", "onUncertain",
    "timeoutMs", "maxDocumentBytes", "maxStateBytes", "maxRequestBytes", "cacheTtlMs",
  ]);
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error(`Unknown Jev config field: ${key}`);
  for (const key of ["instructionPatterns", "ruleFiles", "include", "exclude"]) {
    if (!Array.isArray(value[key]) || !(value[key] as unknown[]).every((item) => typeof item === "string" && item.length > 0)) {
      throw new Error(`Jev config ${key} must be an array of nonempty strings`);
    }
  }
  for (const key of ["timeoutMs", "maxDocumentBytes", "maxStateBytes", "maxRequestBytes", "cacheTtlMs"]) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1) throw new Error(`Invalid Jev config ${key}`);
  }
  for (const key of ["violationThreshold", "clearThreshold"]) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1) {
      throw new Error(`Invalid Jev config ${key}`);
    }
  }
  if ((value.clearThreshold as number) >= (value.violationThreshold as number)) throw new Error("clearThreshold must be below violationThreshold");
  if (value.mode !== "enforce" && value.mode !== "informative") throw new Error("Invalid Jev mode");
  if (typeof value.model !== "string" || !/^jev-[\w.-]+$/.test(value.model)) throw new Error("Invalid Jev model");
  if (typeof value.caseSensitive !== "boolean") throw new Error("caseSensitive must be boolean");
  if (value.instructionRoot !== undefined && (typeof value.instructionRoot !== "string" || !value.instructionRoot)) throw new Error("Invalid instructionRoot");
  for (const key of ["onUnavailable", "onUncertain"]) {
    if (value[key] !== "warn" && value[key] !== "block") throw new Error(`Invalid ${key}`);
  }
  if ((value.instructionPatterns as string[]).some((pattern) => pattern.includes("/") || pattern.includes("\\"))) {
    throw new Error("instructionPatterns must match filenames, not paths");
  }
  return value as unknown as Config;
}

export function parseBlocks(text: string, config = false): Block[] {
  let start = 0;
  if (config) {
    const { bodyStart } = splitFrontmatter(text);
    const rules = /^## Rules\s*\r?$/m.exec(text.slice(bodyStart));
    if (!rules) return [];
    start = bodyStart + rules.index + rules[0].length;
  }
  const masked = text.slice(0, start).replace(/[^\r\n]/g, " ") + text.slice(start);
  const tree = fromMarkdown(masked);
  const nodes = tree.children.flatMap((node) => node.type === "list" ? node.children : [node]);
  return nodes.filter((node) => node.position?.start.offset !== undefined).map((node) => ({
    lines: [node.position!.start.line, node.position!.end.line],
    text: text.slice(node.position!.start.offset, node.position!.end.offset),
    rule: ["paragraph", "listItem", "blockquote"].includes(node.type),
  }));
}

async function repositoryRoot(cwd: string): Promise<string> {
  let path = cwd;
  while (true) {
    try {
      await access(resolve(path, ".git"));
      return path;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (dirname(path) === path) return cwd;
    path = dirname(path);
  }
}

export class Policy {
  private readonly parsed = new Map<string, Block[]>();
  private readonly knownInstructions = new Set<string>();
  private constructor(
    readonly config: Config,
    readonly configPath: string,
    readonly configText: string,
    readonly root: string,
    readonly rulePaths: string[],
  ) {}

  static async load(configPath: string, cwd: string): Promise<Policy> {
    configPath = resolve(configPath);
    const text = await boundedRead(await canonical(configPath), 262144);
    const config = parseConfig(text);
    const root = await canonical(config.instructionRoot ? resolve(cwd, config.instructionRoot) : await repositoryRoot(await canonical(cwd)));
    const rulePaths = config.ruleFiles.map((path) => resolve(dirname(configPath), path));
    return new Policy(config, configPath, text, root, rulePaths);
  }

  instructionName(path: string): boolean {
    return this.config.instructionPatterns.some((pattern) => minimatch(basename(path), pattern, { nocase: !this.config.caseSensitive, dot: true }));
  }
  async protected(path: string): Promise<boolean> {
    if ([this.configPath, ...this.rulePaths].includes(path) || this.instructionName(path)) return true;
    await this.discover(path);
    const sources = [this.configPath, ...this.rulePaths, ...this.knownInstructions];
    const identity = async (file: string) => {
      try { return await stat(file, { bigint: true }); }
      catch (error) { if (isMissing(error)) return undefined; throw error; }
    };
    const target = await identity(path);
    for (const source of sources) {
      const resolved = await canonical(source);
      if (resolved === path) return true;
      const other = target && target.nlink > 1n ? await identity(resolved) : undefined;
      if (target && other && target.ino !== 0n && target.dev === other.dev && target.ino === other.ino) return true;
    }
    return false;
  }
  code(path: string): boolean {
    const local = relative(this.root, path).split("\\").join("/");
    const matches = (pattern: string) => minimatch(local, pattern, { dot: true, nocase: !this.config.caseSensitive });
    return !isSensitive(path) && this.config.include.some(matches) && !this.config.exclude.some(matches);
  }

  private async discover(target: string): Promise<string[]> {
    const paths: string[] = [];
    const ancestors: string[] = [];
    let dir = dirname(target);
    while (within(this.root, dir)) {
      ancestors.unshift(dir);
      if (dir === this.root) break;
      dir = dirname(dir);
    }
    for (const dir of ancestors) {
      let names: string[];
      try {
        names = (await readdir(dir)).filter((name) => this.instructionName(name)).sort();
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      for (const name of names) {
        const source = resolve(dir, name);
        if (!within(this.root, await canonical(source))) throw new Error("An instruction symlink leaves the configured root");
        paths.push(source);
        this.knownInstructions.add(source);
      }
    }
    return paths;
  }

  async collect(target: string): Promise<PolicySnapshot> {
    if (!within(this.root, target)) throw new Error("Target is outside the configured instruction root");
    if (await readOptional(this.configPath) !== this.configText) throw new Error("Jev config changed; run /jev reload");
    const configured = new Set([this.configPath, ...this.rulePaths]);
    const paths = [...configured, ...await this.discover(target)];
    const documents: Document[] = [];
    for (const source of new Set(paths)) {
      const canonicalSource = await canonical(source);
      const text = await boundedRead(canonicalSource, this.config.maxDocumentBytes);
      const sha256 = digest(text);
      const key = `${source}\0${sha256}\0${source === this.configPath}`;
      let blocks = this.parsed.get(key);
      if (!blocks) {
        blocks = parseBlocks(text, source === this.configPath);
        if (this.parsed.size >= 128) this.parsed.delete(this.parsed.keys().next().value!);
        this.parsed.set(key, blocks);
      }
      const kind = configured.has(source) ? "configured" : "instructions";
      documents.push({ kind, source, canonicalSource, sha256, blocks });
    }
    return { documents, fingerprint: digest(JSON.stringify(documents)) };
  }
}
