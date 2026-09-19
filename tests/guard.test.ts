import assert from "node:assert/strict";
import { link, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Guard, GuardError } from "../src/guard.ts";
import { JevClient } from "../src/jev.ts";
import { configText, fetcher, fixture, reply } from "./helpers.ts";

const key = () => "test-only-typesafe-credential";

test("enforcement leaves bytes unchanged while informative mode returns findings and applies", async (t) => {
  for (const mode of ["enforce", "informative"] as const) {
    const f = await fixture({ mode }); t.after(f.cleanup);
    let commits = 0;
    const guard = new Guard(f.policy, new JevClient(fetcher((request) => reply(request, 0.99)), key));
    const apply = () => guard.mutate(f.target, "console.log(password);", async () => { commits++; await writeFile(f.target, "console.log(password);"); });
    if (mode === "enforce") {
      await assert.rejects(apply(), (error: GuardError) => {
        assert.equal(error.report.status, "violation");
        assert.equal(error.report.applied, false);
        assert.equal(error.report.violations[0].text, "Do not log passwords.");
        return true;
      });
      assert.equal(commits, 0);
      assert.equal(await readFile(f.target, "utf8"), "const value = 1;\n");
    } else {
      const report = await apply();
      assert.equal(report.status, "violation");
      assert.equal(report.applied, true);
      assert.equal(commits, 1);
    }
  }
});

test("outages follow mode and configured failure policy without claiming a clean verdict", async (t) => {
  for (const [mode, onUnavailable, block] of [["informative", "block", false], ["enforce", "block", true], ["enforce", "warn", false]] as const) {
    const f = await fixture({ mode, onUnavailable }); t.after(f.cleanup);
    const guard = new Guard(f.policy, new JevClient(fetcher(() => new Response(null, { status: 529 })), key));
    let committed = false;
    const operation = guard.mutate(f.target, "new", async () => { committed = true; });
    if (block) await assert.rejects(operation, (error: GuardError) => error.report.status === "unavailable");
    else assert.equal((await operation).status, "unavailable");
    assert.equal(committed, !block);
  }
});

test("uncertain verdicts have a separate enforcement policy", async (t) => {
  const f = await fixture({ mode: "enforce", onUncertain: "block" }); t.after(f.cleanup);
  const guard = new Guard(f.policy, new JevClient(fetcher((request) => reply(request, 0.5)), key));
  await assert.rejects(guard.mutate(f.target, "new", async () => { assert.fail("must not write"); }),
    (error: GuardError) => error.report.status === "uncertain" && error.report.violations.length === 0);
});

test("external target changes are never reverted or overwritten, even in informative mode", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const guard = new Guard(f.policy, new JevClient(fetcher(async (request) => {
    await writeFile(f.target, "someone else's work");
    return reply(request);
  }), key));
  await assert.rejects(guard.mutate(f.target, "new", async () => { assert.fail("must not write"); }),
    (error: GuardError) => error.report.status === "stale");
  assert.equal(await readFile(f.target, "utf8"), "someone else's work");
});

test("rule changes discard the verdict and evaluate a fresh snapshot once", async (t) => {
  const f = await fixture({ mode: "enforce" }); t.after(f.cleanup);
  let calls = 0;
  const guard = new Guard(f.policy, new JevClient(fetcher(async (request) => {
    calls++;
    if (calls === 1) await writeFile(join(f.root, "rules.md"), "Different rule.\n");
    return reply(request, calls === 1 ? 0.99 : 0.01);
  }), key));
  const report = await guard.mutate(f.target, "new", () => writeFile(f.target, "new"));
  assert.equal(calls, 2);
  assert.equal(report.status, "pass");
  assert.equal(report.violations.length, 0);
});

test("new ancestor instructions during evaluation are also detected", async (t) => {
  const f = await fixture({ mode: "enforce" }); t.after(f.cleanup);
  let calls = 0;
  const guard = new Guard(f.policy, new JevClient(fetcher(async (request) => {
    calls++;
    if (calls === 1) await writeFile(join(f.root, "AGENTS.md"), "New ancestor rule.\n");
    return reply(request, calls === 1 ? 0.01 : 0.99);
  }), key));
  await assert.rejects(guard.mutate(f.target, "new", async () => assert.fail("must not write")), (error: GuardError) => {
    assert.equal(error.report.status, "violation");
    assert(error.report.violations.some((finding) => finding.text === "New ancestor rule."));
    return true;
  });
  assert.equal(calls, 2);
});

test("continually changing instructions and mid-flight config changes stop the write", async (t) => {
  const f = await fixture({ mode: "enforce" }); t.after(f.cleanup);
  let calls = 0;
  const changing = new Guard(f.policy, new JevClient(fetcher(async (request) => {
    await writeFile(join(f.root, "rules.md"), `Rule ${++calls}.\n`);
    return reply(request);
  }), key));
  await assert.rejects(changing.mutate(f.target, "new", async () => assert.fail("must not write")), (error: GuardError) => error.report.status === "stale");
  assert.equal(calls, 2);
  const configChange = new Guard(f.policy, new JevClient(fetcher(async (request) => {
    await writeFile(f.config, configText({ mode: "informative" }));
    return reply(request);
  }), key));
  await assert.rejects(configChange.mutate(f.target, "new", async () => assert.fail("must not write")), (error: GuardError) => error.report.status === "stale");
});

test("policy edits require a user override, bound to exact content and consumed once", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const guard = new Guard(f.policy);
  let token = "";
  const next = configText({ mode: "enforce" });
  await assert.rejects(guard.mutate(f.config, next, async () => assert.fail("must not write")), (error: GuardError) => {
    assert.equal(error.report.status, "protected");
    token = error.report.overrideToken!;
    return true;
  });
  assert.equal(guard.pendingPath(token), f.config);
  assert.equal(guard.allowOnce("unknown"), false);
  assert.equal(guard.allowOnce(token), true);
  await assert.rejects(guard.mutate(f.config, next + "changed", async () => assert.fail("must not write")), GuardError);
  const report = await guard.mutate(f.config, next, async () => {});
  assert.equal(report.status, "override");
  await assert.rejects(guard.mutate(f.config, next, async () => assert.fail("must not write")), GuardError);
});

test("violation overrides require unchanged instructions as well as unchanged code", async (t) => {
  const f = await fixture({ mode: "enforce" }); t.after(f.cleanup);
  const guard = new Guard(f.policy, new JevClient(fetcher((request) => reply(request, 0.99)), key));
  let token = "";
  await assert.rejects(guard.mutate(f.target, "new", async () => {}), (error: GuardError) => { token = error.report.overrideToken!; return true; });
  guard.allowOnce(token);
  await writeFile(join(f.root, "rules.md"), "A changed rule.");
  await assert.rejects(guard.mutate(f.target, "new", async () => assert.fail("must not write")), GuardError);
});

test("no-op, non-code, generated, and sensitive files never reach the service", async (t) => {
  const f = await fixture({ mode: "enforce" }); t.after(f.cleanup);
  const guard = new Guard(f.policy, new JevClient(async () => assert.fail("must not call Jev"), key));
  for (const [path, after] of [[f.target, "const value = 1;\n"], [join(f.root, "README.md"), "doc"], [join(f.root, "x.generated.ts"), "generated"], [join(f.root, ".env"), "SECRET=value"], [join(f.root, "binary.ts"), "binary\0data"]]) {
    const report = await guard.mutate(path, after, async () => {});
    assert.equal(report.status, "skipped");
  }
});

test("instruction backing files and hard-link aliases require approval", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const backing = join(f.root, "backing.ts");
  await writeFile(backing, "Do not weaken policy.\n");
  await symlink(backing, join(f.root, "AGENTS.md"));
  const alias = join(f.root, "alias.md");
  await link(join(f.root, "rules.md"), alias);
  const guard = new Guard(f.policy, new JevClient(async () => assert.fail("must not call Jev"), key));
  for (const target of [backing, alias]) {
    await assert.rejects(guard.mutate(target, "weakened", async () => assert.fail("must not write")),
      (error: GuardError) => error.report.status === "protected");
  }
  const snapshot = await f.policy.collect(f.target);
  const instruction = snapshot.documents.find((doc) => doc.source.endsWith("AGENTS.md"))!;
  assert.equal(instruction.canonicalSource, backing);
});

test("policy resolution errors use structured mode-specific unavailable handling", async (t) => {
  for (const mode of ["informative", "enforce"] as const) {
    const f = await fixture({ mode }); t.after(f.cleanup);
    const path = join(f.root, "rules.md");
    await unlink(path);
    await symlink(path, path);
    const guard = new Guard(f.policy, new JevClient(async () => assert.fail("must not call Jev"), key));
    let committed = false;
    const operation = guard.mutate(f.target, "new", async () => { committed = true; });
    if (mode === "informative") assert.equal((await operation).status, "unavailable");
    else await assert.rejects(operation, (error: GuardError) => error.report.status === "unavailable" && !error.report.overrideToken);
    assert.equal(committed, mode === "informative");
  }
});

test("commit receives the canonical target rather than the mutable symlink alias", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const alias = join(f.root, "alias.ts");
  await symlink(f.target, alias);
  const guard = new Guard(f.policy, new JevClient(fetcher((request) => reply(request)), key));
  await guard.mutate(alias, "new", async (target) => { assert.equal(target, f.target); });
});

test("cancellation does not degrade to an informative write", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const abort = new AbortController();
  const guard = new Guard(f.policy, new JevClient(fetcher((request) => { abort.abort(); return reply(request); }), key));
  await assert.rejects(guard.mutate(f.target, "new", async () => assert.fail("must not write"), abort.signal), { name: "AbortError" });
});
