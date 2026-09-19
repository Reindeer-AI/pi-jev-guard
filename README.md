# Pi Jev Guard

A Pi extension that checks proposed code edits against Markdown rules using [TypeSafe Jev](https://docs.typesafe.ai/). It reviews the proposed content before Pi writes it and returns the exact instruction text and source line range for each detected violation.

The default **informative** mode reports findings without blocking edits. **Enforcement** mode blocks detected violations in code selected for review. By default, code edits outside Pi's current repository are skipped without review, even in enforcement mode; see [Scope and cross-repository edits](#scope-and-cross-repository-edits).

This is a semantic review aid, not a replacement for tests, linters, or a security sandbox.

## Install

Requires Pi 0.85.1 or newer and Node 22.19 or newer.

```sh
pi install git:github.com/Reindeer-AI/pi-jev-guard
```

Set `TYPESAFE_API_KEY` in Pi's environment, then restart Pi. The extension does not read `.env` files automatically. Use your shell or secret manager to provide the key; do not place it in a policy file.

The package provides a generic starter policy. It contains no organization-specific policy, remote context dependency, or bundled repository instruction files.

## Scope and cross-repository edits

The guard selects one `instructionRoot` when the policy loads. By default, this is the Git repository root containing Pi's working directory, or the working directory itself when outside Git. It does **not** select a new root or configuration for each edited file. Installing the extension globally does not make its checks global.

For example, if Pi starts in `/workspace/app-a/src`, with a Git repository rooted at `/workspace/app-a`, the default code globs produce these results:

| Edit target | Behavior |
| --- | --- |
| `/workspace/app-a/src/main.ts` | Reviewed. |
| `/workspace/app-a/tests/main.test.ts` | Reviewed, even though it is outside Pi's working directory. |
| `/workspace/app-b/src/main.ts` | Skipped without review because it is outside the active root. |

For an ordinary out-of-scope code edit, the guard returns `status: "skipped"`, makes no Jev request, and permits the write in **both modes**. A successful write reports `applied: true`. `onUnavailable: block` does not block a skipped edit: no evaluation was attempted. Policy-file approval requirements still apply separately.

Run `/jev status` to see the active root and config. To review code in another repository, either start Pi in that repository or deliberately expand the active config's root to a common parent, for example:

```yaml
instructionRoot: /workspace
```

Run `/jev reload` after changing the config. Code globs are then relative to `/workspace`, and matching ancestor instructions along each target's path are collected from that root downwards. Widening the root can bring additional repositories and parent-level instructions into scope, so choose it deliberately.

**A shared root still uses one config.** The guard does not automatically load each target repository's `.pi/jev-guard.md`. The mode, code globs, thresholds, and explicit `ruleFiles` all come from the selected config. Use separate Pi sessions when repositories need independent configurations.

## Customize the rules

From the repository you want Pi to edit, copy the starter config:

```sh
mkdir -p .pi
curl -fsSL https://raw.githubusercontent.com/Reindeer-AI/pi-jev-guard/main/policy.md \
  -o .pi/jev-guard.md
```

Edit that file's frontmatter and the paragraphs or list items under `## Rules`, then run `/jev reload`. Pi must trust the project before the extension uses its project-local config.

Each rule should describe one requirement that can be judged from the changed code. Keep conditions and exceptions in the same paragraph or list item. For example:

```markdown
## Rules

- Use the application logger in production code. Direct console output is allowed
  in command-line entry points and test fixtures.

- Parameterize SQL values instead of concatenating request input into a query.
```

These are examples, not additional built-in rules. Adapt the starter policy to your project rather than assuming its rules fit every codebase.

### Repository instruction files

Ancestor instruction files come from the active workspace; they are not bundled with this extension. For an in-scope file, discovery follows its ancestor path from the active `instructionRoot` to the file's directory. With the default repository root, editing `src/payments/service.ts` searches that root, `src/`, and `src/payments/`, but not unrelated sibling directories. This discovery does not switch roots or configs for cross-repository targets.

The default filename globs are:

```yaml
instructionPatterns: ["AGENT*.md", "CLAUDE.md", "REVIEW.md"]
caseSensitive: false
```

Add names such as `STYLE.md`, or use `*.md` if every Markdown file along the path is intended as instructions. Broad patterns can add irrelevant text and exhaust the request budget; named instruction files are usually a better choice.

Use `ruleFiles` for additional explicit policy files. Those paths are relative to the selected config file. For example, a config at `.pi/jev-guard.md` can include a repository-root policy with `ruleFiles: ["../code-policy.md"]`. The default is an empty list because the starter rules are inline.

Configured rules are described to Jev as mandatory. Ancestor instructions are sent in root-to-leaf order, with closer instructions governing local conventions. Conflict interpretation is semantic, not a deterministic text-merge algorithm.

## Configuration

The first applicable config is used:

1. `--jev-config /path/to/policy.md`, or `JEV_GUARD_CONFIG` when the flag is absent.
2. The trusted project's `.pi/jev-guard.md`.
3. `~/.pi/agent/jev-guard.md`.
4. This package's `policy.md`.

Pi distributions with a different config-directory name use that name instead of `.pi`. A malformed selected config fails closed; it does not silently fall back. Copy the complete starter config before customizing it, because its frontmatter fields are validated.

| Setting | Behavior |
| --- | --- |
| `mode` | `informative` or `enforce`. |
| `model` | Pinned by default to `jev-1.13.0`. Retest thresholds when changing models. |
| `instructionPatterns` | Filename globs searched along the edited file's ancestor path. |
| `caseSensitive` | Controls instruction-name and code-glob matching; defaults to `false`. |
| `instructionRoot` | Root for instruction discovery and code review, resolved relative to Pi's working directory and selected when the policy loads. Defaults to that working directory's repository root, or the working directory outside Git. It does not switch automatically for cross-repository edits. |
| `ruleFiles` | Additional Markdown policy paths relative to the config file. Missing files are evaluation failures. |
| `include`, `exclude` | Code globs relative to the instruction root. Exclusions win. |
| `violationThreshold` | Probabilities at or above this value are violations; default `0.85`. |
| `clearThreshold` | Values below this are clear; values between the thresholds are uncertain; default `0.2`. |
| `onUnavailable` | `block` or `warn` in enforcement mode; default `block`. |
| `onUncertain` | `block` or `warn` in enforcement mode; default `warn`. |
| `timeoutMs` | Deadline for the HTTP request and response body; default `5000`. |
| `maxDocumentBytes` | Per-document byte limit; default `65536`. |
| `maxStateBytes`, `maxRequestBytes` | Local request budgets; defaults `24000` and `60000`. The API's token limits also apply. |
| `cacheTtlMs` | Cache lifetime for identical successful evaluations; default `60000`. |

Only configured code globs determine eligibility. Unknown extensions and Markdown code fences are not automatically classified as code. Sensitive paths, generated-file exclusions, and content containing NUL bytes are not submitted. Oversized inputs are reported as unavailable rather than silently truncated.

## How evaluation works

1. The extension uses Pi's built-in edit/write implementation to obtain the exact proposed content while holding Pi's per-file mutation queue.
2. It snapshots configured policy and applicable repository instructions. Markdown paragraphs, list items, and blockquotes become candidate rule spans; headings and code examples remain context.
3. It sends all applicable instructions and the before/after code in one batched request. Each question points to a predefined instruction block.
4. It maps Jev's verdicts back to those same snapshots. Jev does not generate filenames, line numbers, or explanations.
5. It checks for detected target or instruction changes before committing through the captured canonical path. A changed instruction snapshot gets one fresh evaluation; repeated changes stop the edit.

Each finding includes the full original rule text, even if the calling agent cannot access the config:

```json
{
  "source": "/workspace/AGENTS.md",
  "snapshot": "<SHA-256 of the original document>",
  "lines": [18, 23],
  "text": "<original instruction block>",
  "probability": 0.98
}
```

Line ranges are one-based and inclusive. A list item includes its nested conditions and examples. The source-to-span mapping is deterministic; the model's interpretation and verdict are not guaranteed to be correct.

Jev is asked to flag introduced or worsened code-level violations, not unchanged existing issues, unfinished future work, review/publication procedures, or unsupported claims about missing context. Evaluate representative edits before relying on enforcement.

## Feedback and commands

The original tool result retains its diff and receives a JSON `jev` object containing `status`, `mode`, `applied`, `violations`, `uncertain`, and elapsed time. Blocked edits return this JSON as a tool error. Unavailable or uncertain checks are not reported as passes.

| Command | Purpose |
| --- | --- |
| `/jev status` | Show the mode, config, discovery root, model, and whether the key is present. Never displays the key. |
| `/jev rules <path>` | Show the instruction snapshots that apply to a file. |
| `/jev reload` | Reload configuration after the agent is idle. |
| `/jev allow-once <token>` | Ask the user to approve one exact retry of a blocked edit. |

Override tokens expire after two minutes and are bound to the target, before/after content, and evaluated policy. Confirmation requires an interactive user; there is no model-callable override tool. An unavailable policy set has no override token and must be fixed first.

Changes to active configuration, explicit rule files, matching instruction filenames, and discovered instruction backing files require user approval even in informative mode. Canonical targets and hard-link identities are checked. Config changes require `/jev reload`; other instruction changes are detected on the next check.

## Privacy and enforcement limits

- Code before/after content and applicable instruction text are sent to TypeSafe. Enable the extension only on material you are permitted to send to that service.
- Exclusions cover `.env` files and common private-key paths. The request is also checked for the current API key and private-key markers. These checks are not a general secret detector.
- The extension does not log source code, credentials, or service error bodies. Pi still records normal tool calls and results in its session history. Guard audit entries contain statuses, counts, timing, model, and cache use.
- Only in-scope changes through this Pi process's `edit` and `write` tools are reviewed. Out-of-scope edits are permitted without review, including in enforcement mode; see [Scope and cross-repository edits](#scope-and-cross-repository-edits). Shell commands, custom tools, external editors, and other agents can bypass the guard. Do not combine it with extensions that replace these tools for remote execution.
- Consistency checks are not an OS-level transaction with other processes. Use filesystem isolation for stronger enforcement.
- HTTP failures are surfaced without automatic retries. Errors are not cached. Cancellation stops evaluation instead of permitting an informative-mode write.
- Pinned-model responses must match the requested model. The documented `jev-latest` and `jev-preview` aliases may resolve to a versioned model.
- Successful identical evaluations can use a bounded in-memory cache. Code, instruction, model, or threshold changes invalidate the cache key. Provider-side prompt caching is not assumed.

## Development

```sh
git clone https://github.com/Reindeer-AI/pi-jev-guard.git
cd pi-jev-guard
npm ci --ignore-scripts
npm run check
pi -e .
```

Tests use the real Pi edit/write implementations with a fake Jev HTTP boundary. They cover rule discovery, exact-span attribution, stale snapshots, protected aliases, mode-specific failures, cancellation, response validation, multi-edits, BOM/CRLF preservation, and concurrent writes.

The optional live smoke test sends synthetic code, the generic starter policy, and a temporary repository's `AGENTS.md`. It verifies one allowed edit and one edit blocked by the repository's instructions, without changing your working tree:

```sh
# With TYPESAFE_API_KEY already exported:
npm run smoke

# Or explicitly load a local environment file for this process:
node --env-file=/absolute/path/to/credentials.env --import tsx scripts/smoke.ts
```

A passing smoke test demonstrates those examples, not general rule-detection accuracy.
