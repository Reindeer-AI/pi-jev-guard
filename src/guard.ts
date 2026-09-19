import { basename } from "node:path";
import type { Evaluation, Finding } from "./jev.ts";
import { JevClient } from "./jev.ts";
import { canonical, digest, isSensitive, Policy, readOptional, type Mode, type PolicySnapshot } from "./policy.ts";

export interface Report {
  status: "pass" | "violation" | "uncertain" | "unavailable" | "skipped" | "stale" | "protected" | "override";
  mode: Mode;
  applied: boolean;
  violations: Finding[];
  uncertain: Finding[];
  reason?: string;
  model?: string;
  cached?: boolean;
  elapsedMs: number;
  overrideToken?: string;
}
export class GuardError extends Error {
  constructor(readonly report: Report) {
    super(JSON.stringify({ jev: report }));
  }
}
interface Pending {
  fingerprint: string;
  path: string;
  expires: number;
  allowed: boolean;
}

export class Guard {
  private readonly pending = new Map<string, Pending>();
  constructor(readonly policy: Policy, private readonly client = new JevClient()) {}

  pendingPath(token: string): string | undefined {
    const pending = this.pending.get(token);
    return pending && pending.expires > Date.now() ? pending.path : undefined;
  }
  allowOnce(token: string): boolean {
    const pending = this.pending.get(token);
    if (!pending || pending.expires <= Date.now()) return false;
    pending.allowed = true;
    return true;
  }
  private token(fingerprint: string, path: string): string {
    const token = fingerprint.slice(0, 24);
    if (this.pending.size >= 64) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(token, { fingerprint, path, expires: Date.now() + 120000, allowed: false });
    return token;
  }
  private consume(fingerprint: string): boolean {
    const token = fingerprint.slice(0, 24);
    const pending = this.pending.get(token);
    if (!pending || pending.fingerprint !== fingerprint || !pending.allowed || pending.expires <= Date.now()) return false;
    this.pending.delete(token);
    return true;
  }

  async mutate(
    path: string,
    after: string,
    commit: (canonicalTarget: string) => Promise<void>,
    signal?: AbortSignal,
    original?: string | null,
  ): Promise<Report> {
    const started = Date.now();
    const { config } = this.policy;
    const report: Report = { status: "pass", mode: config.mode, applied: false, violations: [], uncertain: [], elapsedMs: 0 };
    const finish = () => { report.elapsedMs = Date.now() - started; return report; };
    const stop = (status: Report["status"], reason: string): never => {
      report.status = status;
      report.reason = reason;
      throw new GuardError(finish());
    };
    signal?.throwIfAborted();
    const target = await canonical(path);
    const before = original === undefined ? await readOptional(target) : original;
    const assertTarget = async () => {
      signal?.throwIfAborted();
      if (await canonical(path) !== target || await readOptional(target) !== before) {
        stop("stale", "Target changed during evaluation; retry against the current file");
      }
    };
    await assertTarget();
    let protectedFile = this.policy.instructionName(basename(path));
    let protectionFailure: string | undefined;
    try { protectedFile ||= await this.policy.protected(target); }
    catch (error) { protectionFailure = error instanceof Error ? error.message : "Unable to resolve policy paths"; }
    const baseFingerprint = digest(JSON.stringify([target, before, after, this.policy.configText]));
    let policy: PolicySnapshot | undefined;
    let fingerprint = baseFingerprint;

    if (before === after) {
      report.status = "skipped";
      report.reason = "No content change";
    } else if (protectedFile) {
      // A policy edit cannot authorize itself, even in informative mode.
      if (this.consume(baseFingerprint)) {
        report.status = "override";
      } else {
        report.overrideToken = this.token(baseFingerprint, target);
        stop("protected", "Policy changes require /jev allow-once <overrideToken> from the user");
      }
    } else if (protectionFailure) {
      report.status = "unavailable";
      report.reason = protectionFailure;
    } else if (isSensitive(path) || !this.policy.code(target) || before?.includes("\0") || after.includes("\0")) {
      report.status = "skipped";
      report.reason = "File is outside the configured code scope, excluded, or contains binary data";
    } else {
      for (let attempt = 0; attempt < 2; attempt++) {
        policy = undefined;
        let evaluation: Evaluation | undefined;
        try {
          policy = await this.policy.collect(target);
          fingerprint = digest(`${baseFingerprint}\0${policy.fingerprint}`);
          if (this.consume(fingerprint)) {
            report.status = "override";
          } else {
            evaluation = await this.client.evaluate(config, policy, target, before, after, signal);
          }
        } catch (error) {
          signal?.throwIfAborted();
          report.status = "unavailable";
          report.reason = error instanceof Error ? error.message : "Unable to evaluate the edit";
        }
        await assertTarget();
        if (policy) {
          let fresh: PolicySnapshot;
          try {
            fresh = await this.policy.collect(target);
          } catch {
            stop("stale", "Instructions changed or became unreadable during evaluation; retry after /jev reload if needed");
          }
          if (fresh!.fingerprint !== policy.fingerprint) {
            if (attempt === 0) {
              report.status = "pass";
              delete report.reason;
              continue;
            }
            stop("stale", "Instructions changed repeatedly during evaluation; edit not applied");
          }
        }
        if (evaluation) {
          Object.assign(report, evaluation);
          report.status = evaluation.violations.length ? "violation" : evaluation.uncertain.length ? "uncertain" : "pass";
        }
        break;
      }
    }
    const blocked = config.mode === "enforce" && (
      report.status === "violation" ||
      report.status === "uncertain" && config.onUncertain === "block" ||
      report.status === "unavailable" && config.onUnavailable === "block"
    );
    if (blocked) {
      if (policy) report.overrideToken = this.token(fingerprint, target);
      throw new GuardError(finish());
    }
    await assertTarget();
    await commit(target);
    report.applied = true;
    return finish();
  }
}
