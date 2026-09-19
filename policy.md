---
mode: informative
model: jev-1.13.0
instructionPatterns: ["AGENT*.md", "CLAUDE.md", "REVIEW.md"]
caseSensitive: false
ruleFiles: []
include:
  - "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py,pyi,go,rs,java,kt,kts,c,cc,cpp,h,hpp,cs,rb,php,swift,scala,sh,bash,zsh,fish,sql,vue,svelte,css,scss,tf,proto}"
  - "**/{Dockerfile,Makefile,Justfile}"
exclude:
  - "**/{node_modules,vendor,dist,build,coverage,.git}/**"
  - "**/*.{min.js,generated.ts,generated.js}"
  - "**/{package-lock.json,pnpm-lock.yaml,yarn.lock,bun.lock,bun.lockb}"
violationThreshold: 0.85
clearThreshold: 0.2
onUnavailable: block
onUncertain: warn
timeoutMs: 5000
maxDocumentBytes: 65536
maxStateBytes: 24000
maxRequestBytes: 60000
cacheTtlMs: 60000
---
# Starter policy

Copy this file to the repository being edited as `.pi/jev-guard.md`, then adapt
the settings and rules to that repository. Matching ancestor instruction files
are discovered in that repository automatically; they are not bundled here.

Add focused requirements as paragraphs or list items below `## Rules`. Keep
conditions and exceptions in the same block. Use `ruleFiles` for additional
Markdown policies, with paths relative to this config file. Remove or replace
these starter rules if they do not fit your project.

## Rules

- Do not embed passwords, API keys, access tokens, or private keys in application
  source. Load credentials from runtime configuration. Clearly identified dummy
  values in tests and examples are allowed.

- Do not silently discard operational failures. Propagate an error or handle it
  explicitly. Best-effort cleanup may ignore a failure when that behavior is
  intentional and documented.
