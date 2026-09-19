import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME, createEditToolDefinition, createWriteToolDefinition, getAgentDir,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Guard, GuardError, type Report } from "./src/guard.ts";
import { canonical, isMissing, Policy } from "./src/policy.ts";

const bundledConfig = fileURLToPath(new URL("./policy.md", import.meta.url));

export default function jevGuard(pi: ExtensionAPI) {
  let guard: Guard | undefined;
  let loadError = "Jev guard has not initialized";
  pi.registerFlag("jev-config", { description: "Path to the Jev guard Markdown config", type: "string" });

  async function load(ctx: ExtensionContext) {
    guard = undefined;
    const explicit = pi.getFlag("jev-config") || process.env.JEV_GUARD_CONFIG;
    const paths = explicit ? [resolve(ctx.cwd, String(explicit))] : [
      ...(ctx.isProjectTrusted() ? [join(ctx.cwd, CONFIG_DIR_NAME, "jev-guard.md")] : []),
      join(getAgentDir(), "jev-guard.md"), bundledConfig,
    ];
    try {
      let chosen = paths[0];
      for (const path of paths) {
        try { await access(path); chosen = path; break; }
        catch (error) { if (!isMissing(error)) throw error; }
      }
      guard = new Guard(await Policy.load(chosen, ctx.cwd));
      loadError = "";
      if (ctx.hasUI) ctx.ui.setStatus("jev-guard", `Jev: ${guard.policy.config.mode} (edit/write)`);
    } catch (error) {
      loadError = error instanceof Error ? error.message : "Unable to load Jev configuration";
      if (ctx.hasUI) {
        ctx.ui.setStatus("jev-guard", "Jev: unavailable");
        ctx.ui.notify(loadError, "error");
      }
    }
  }
  pi.on("session_start", (_event, ctx) => load(ctx));
  pi.on("session_shutdown", () => { guard = undefined; });

  function current(): Guard {
    if (!guard) throw new Error(JSON.stringify({ jev: { status: "unavailable", applied: false, reason: loadError } }));
    return guard;
  }
  function record(report: Report, ctx: ExtensionContext) {
    pi.appendEntry("jev-guard", {
      status: report.status, mode: report.mode, applied: report.applied,
      violations: report.violations.length, uncertain: report.uncertain.length,
      elapsedMs: report.elapsedMs, model: report.model, cached: report.cached,
    });
    if (ctx.hasUI && !["pass", "skipped"].includes(report.status)) {
      ctx.ui.notify(`Jev: ${report.status}; edit ${report.applied ? "applied" : "not applied"}`
        + (report.overrideToken ? `; /jev allow-once ${report.overrideToken}` : ""), report.applied ? "warning" : "error");
    }
  }
  async function guarded<T>(ctx: ExtensionContext, action: (active: Guard, report: (value: Report) => void) => Promise<T>): Promise<T> {
    try {
      return await action(current(), (report) => record(report, ctx));
    } catch (error) {
      if (error instanceof GuardError) record(error.report, ctx);
      throw error;
    }
  }

  const edit = createEditToolDefinition(process.cwd());
  pi.registerTool({
    ...edit,
    async execute(id, input, signal, onUpdate, ctx) {
      return guarded(ctx, async (active, report) => {
        let original: string | undefined;
        let verdict: Report | undefined;
        const tool = createEditToolDefinition(ctx.cwd, { operations: {
          access: (path) => access(path, constants.R_OK | constants.W_OK),
          readFile: async (path) => {
            const buffer = await readFile(path);
            original = buffer.toString("utf8");
            return buffer;
          },
          writeFile: async (path, content) => {
            verdict = await active.mutate(path, content, (target) => writeFile(target, content, "utf8"), signal, original);
          },
        } });
        const result = await tool.execute(id, input, signal, onUpdate, ctx);
        report(verdict!);
        return { ...result, content: [...result.content, { type: "text" as const, text: JSON.stringify({ jev: verdict }) }] };
      });
    },
  });

  const write = createWriteToolDefinition(process.cwd());
  pi.registerTool({
    ...write,
    async execute(id, input, signal, onUpdate, ctx) {
      return guarded(ctx, async (active, report) => {
        let verdict: Report | undefined;
        const tool = createWriteToolDefinition(ctx.cwd, { operations: {
          // Defer even directory creation until the gate allows the write.
          mkdir: async () => {},
          writeFile: async (path, content) => {
            verdict = await active.mutate(path, content, async (target) => {
              await mkdir(dirname(target), { recursive: true });
              signal?.throwIfAborted();
              await writeFile(target, content, "utf8");
            }, signal);
          },
        } });
        const result = await tool.execute(id, input, signal, onUpdate, ctx);
        report(verdict!);
        return { ...result, content: [...result.content, { type: "text" as const, text: JSON.stringify({ jev: verdict }) }] };
      });
    },
  });

  pi.registerCommand("jev", {
    description: "Jev guard: status, rules <path>, reload, allow-once <token>",
    handler: async (args, ctx) => {
      const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const argument = rest.join(" ");
      if (command === "reload") {
        await ctx.waitForIdle();
        await load(ctx);
        if (ctx.hasUI && guard) ctx.ui.notify("Jev configuration reloaded", "info");
        return;
      }
      if (command === "allow-once") {
        const active = current();
        const path = active.pendingPath(argument);
        if (!path) throw new Error("Unknown or expired Jev override token");
        if (!ctx.hasUI || !await ctx.ui.confirm("Allow this exact edit once?", path)) return;
        if (!active.allowOnce(argument)) throw new Error("Jev override expired; retry the edit to obtain a fresh token");
        ctx.ui.notify("One exact retry is allowed for two minutes; changed content or policy requires another review", "info");
        return;
      }
      const active = current();
      if (command === "status") {
        pi.sendMessage({ customType: "jev-guard-status", display: true, content: JSON.stringify({
          mode: active.policy.config.mode, config: active.policy.configPath,
          instructionRoot: active.policy.root, tools: ["edit", "write"],
          model: active.policy.config.model, apiKeyPresent: Boolean(process.env.TYPESAFE_API_KEY),
        }, null, 2) }, { triggerTurn: false });
      } else if (command === "rules" && argument) {
        const path = await canonical(isAbsolute(argument) ? argument : resolve(ctx.cwd, argument));
        const policy = await active.policy.collect(path);
        pi.sendMessage({ customType: "jev-guard-rules", display: true, content: JSON.stringify(policy.documents, null, 2) }, { triggerTurn: false });
      } else {
        throw new Error("Usage: /jev status | rules <path> | reload | allow-once <token>");
      }
    },
  });
}
