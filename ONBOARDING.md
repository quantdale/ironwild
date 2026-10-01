# Fresh-machine onboarding

This is the canonical bootstrap entry point for a new workstation or a fresh coding-agent environment. Complete this document before implementation work. The objective is a reproducible machine that can build, test, inspect, and operate this repository without rediscovering tooling mid-campaign.

## 1. Preflight rule

1. Clone the repository and enter its root.
2. Confirm the intended repository/branch and fetch current `origin/main`.
3. Read the repository control-plane documents before changing code: `AGENTS.md`, `README.md`, `ARCHITECTURE*.md`, `.agent/`, active task/campaign state.
4. Install/verify the machine prerequisites below.
5. Enable the committed agent integrations and repository-local skills.
6. Restore dependencies from lockfiles/pins; do not casually upgrade them during bootstrap.
7. Run the baseline validation commands.
8. Only then begin a development campaign. If a prerequisite cannot be satisfied, record it as an environment blocker rather than weakening a gate.

Credentials, API keys, signing material, account logins, licensed assets, and other secrets are machine/user responsibilities. Never commit them.

## 2. Supported host and prerequisites

**Primary host:** Desktop Windows/Linux/macOS with a modern browser and GPU-capable WebGL stack.

**Required machine tools**
- Git
- Node.js/npm compatible with the lockfile
- Chromium for Playwright E2E
- modern desktop browser for manual play/performance checks

**Task-dependent / optional tools**
- GPU profiling tools/Chrome DevTools when investigating frame-time or rendering regressions

## 3. Agent setup

- Load `AGENTS.md` before acting. Prefer committed repository state over chat history.
- Repository-local skills: `goal`.
- Discover and use committed agent adapter/config directories in-place; do not duplicate them globally unless the harness cannot load repository-local configuration.
- Relevant committed agent surfaces: `.agent/`, `.agents/`, `.claude/`, `.kimi-code/`, `.opencode/`.
- MCP policy: No root `.mcp.json` is committed. Use Playwright and browser DevTools directly unless an active campaign explicitly introduces a repository-scoped MCP.
- Keep diagnostic/documentation MCPs narrow. An MCP does not grant architecture, publishing, production, or gate-bypass authority.
- Authenticate GitHub and coding-agent CLIs separately on the machine. Never store tokens in tracked files.

## 4. Bootstrap

```bash
npm ci
npx playwright install chromium
```

The authored-content GLB/KTX2 pipeline is repository-owned. Do not replace procedural/original assets with third-party copyrighted assets during setup.

## 5. Editor/LSP baseline

Use the local JavaScript/TypeScript language service and ESLint. Three.js/Vite APIs must resolve from the repository lockfile, not globally installed versions.

The editor is optional; reliable language diagnostics are not.

## 6. Baseline verification

```bash
npm run lint
npm test
npm run assets:validate
npm run test:e2e
npm run verify
```

A fresh machine is **development-ready** when all applicable non-external gates pass. Hardware/device/signing/account gates may remain explicitly blocked when repository state already classifies them that way.

## 7. Fresh-agent instruction

> Read `AGENTS.md` and `ONBOARDING.md` first. Set up every applicable prerequisite, repository-local skill, MCP/plugin, dependency, browser/device/runtime tool, and validation gate described there. Then read the repository's durable agent state and only start implementation after preflight is green or a genuine environment blocker is recorded. Do not replace pinned tooling, skip gates, or invent work to compensate for a missing machine capability.
