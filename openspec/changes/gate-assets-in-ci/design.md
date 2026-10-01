# Design — Gate assets and dependencies in CI (tooling)

## Current-state analysis

### Measured repository state

`npm audit --audit-level=high` on the current tree:

```text
3 vulnerabilities (1 moderate, 2 high)

brace-expansion  4.0.0 - 5.0.11     Severity: high
  - Quadratic-time expansion causes CPU denial of service (GHSA-q2hr-2g5m-vwhr)
  - DoS via uncontrolled recursion / stack exhaustion (two more advisories)
  fix available via npm audit fix

esbuild <=0.24.2                    Severity: moderate
  - "esbuild enables any website to send any requests to the development
     server and read the response" (GHSA-67mh-4wv8-2f99)
vite <=6.4.2                        (depends on the vulnerable esbuild)
```

`npm run assets:validate` on the current tree:

```text
asset validation OK (5 authored assets)     # exit 0, 0 errors
warnings present, e.g. for env/wayshrine:
  khronos warn: Invalid value 'image/ktx2'. Valid values are ('image/jpeg','image/png')
  khronos warn: Image format not recognized. [/images/0]
  khronos note: Empty node encountered (x3), object may be unused (x2)
```

Shipped authored assets (all with `.provenance.json` sidecars):

```text
public/assets/machines/{skitter,ironmaw,duskwing}.glb
public/assets/player/hunter.glb
public/assets/env/wayshrine.glb
```

`.github/workflows/ci.yml` steps: `npm ci` → `lint` → `test` → `build` → `playwright install` → `test:e2e` → upload report on failure. **No audit step. No asset-validation step.**

`package.json` scripts: `dev, build, preview, lint, test, test:watch, test:e2e, test:e2e:chunked, assets:validate, assets:create-cert, verify`. `verify` = `lint && test && test:e2e` — it does not include `assets:validate`.

### Honest severity calibration

These advisories are **development-time supply-chain risk, not a player-facing exploit**:

- `brace-expansion` is a transitive build-time dependency (via minimatch). The quadratic-expansion and stack-exhaustion issues require an attacker to control the *input pattern set* being expanded — in this repo that is lint globs and matcher patterns, which are repository-controlled. It cannot be triggered by game input at runtime.
- `esbuild`'s issue is explicitly about the **development server** reflecting cross-origin requests. It affects `npm run dev` on a developer's machine, not the built artifact served in production. The `vite` advisory is a dependency consequence of the same.

So: not a P0 security emergency, and it should not be presented as one. It *is* a real hygiene gap because (a) a fix is available, (b) nothing detects a newly introduced advisory, and (c) the same missing gate is what lets a genuinely dangerous future advisory through unnoticed. Framing matters here — the finding is "no supply-chain gate, and the gate that should exist would already be red", not "the game is remotely exploitable".

For the assets: the validator is the mechanism that already exists and already works. Its absence from CI is the gap, and it is the cheapest high-value gate available in this repository — it is a pure function of committed files, runs in ~1 s, and covers provenance/licensing (a real legal requirement for shipped content), glTF structural validity, and the authoring conventions gameplay depends on.

## Intended approach

### 1. Dependency gate

Add a CI step:

```yaml
- name: Dependency audit
  run: npm audit --audit-level=high
```

`npm audit` exits non-zero when advisories at or above the level are present, so the step fails the job without extra scripting. `--audit-level=high` is chosen deliberately: the current tree would fail on `brace-expansion` (high) and pass on the `esbuild`/`vite` moderate pair, so remediation can be staged.

Remediation path, in order:

1. `npm audit fix` for the `brace-expansion` transitive bump — lowest risk (transitive, semver-compatible).
2. The `esbuild`/`vite` pair requires a `vite` upgrade past 6.4.2. The repo is on `vite ^5.4.0`. This is a **major** version jump with real blast radius (build config in `vite.config.js`: `manualChunks`, the `test` block, `test:e2e` driving `vite preview`, and the `chunkSizeWarningLimit` behavior). Treat it as its own, separately verified step — do **not** bundle it silently into the gate change.
3. If the vite upgrade is deferred, record the deferral and its rationale in the baseline note so the residual advisory is a documented decision rather than an oversight. A gate that is permanently red gets disabled, which is worse than no gate.

### 2. Asset-validation gate

Add to CI, in the fast job before the build:

```yaml
- name: Asset validation
  run: npm run assets:validate
```

and add `assets:validate` to the `verify` script so the local gate matches CI:

```
"verify": "npm run lint && npm test && npm run assets:validate && npm run test:e2e"
```

The validator already exits 1 on any entry in its `failures` list (errors) and 0 otherwise (warnings are printed). No change to its exit semantics is required. The one thing to add is **not** treating warnings as failures: the current five assets produce Khronos warnings that are expected and correct for this pipeline:

- `image/ktx2` + "Image format not recognized" — the Khronos validator does not support `KHR_texture_basisu`; KTX2 is validated by `gltf-validator`'s successor tooling or by decode-in-browser, which the E2E `asset-pipeline.spec.js` already proves (it asserts the KTX2 texture decodes to a real `DataTexture` of the expected size).
- "Empty node encountered" — the certification prop's socket/weak-point placeholder nodes are intentionally empty.
- "Object may be used" — informational.

So warnings stay visible in the log (the validator already prints them) and errors stay fatal. If a future asset produces a *new* warning class, that is a review signal, not a build break.

### 3. Reproducible asset generation

Expose the existing scripts as npm aliases, mirroring the current `assets:create-cert`:

| script file | npm alias |
| --- | --- |
| `scripts/create-cert-asset.mjs` | `assets:create-cert` (exists) |
| `scripts/create-hunter-asset.mjs` | `assets:create-hunter` |
| `scripts/create-skitter-asset.mjs` | `assets:create-skitter` |
| `scripts/create-machines-assets.mjs` | `assets:create-machines` |

`scripts/lib/glb.mjs` is the shared writer; the aliases expose it without changing it. Do not wire asset generation into `build` or `verify` — assets are committed source, generated deliberately, not built per CI run. The aliases exist so the README can say "run this to regenerate that asset" and that statement stays true.

### 4. Baseline note

Add a short `docs/ASSET-GATES.md` recording:

- the audit baseline (which advisories were present, their class, and the decision taken);
- the validator's contract (what is fatal, what is a warning, and why the KTX2 warnings are expected);
- the regeneration command table from section 3;
- the rule that a gate which is permanently red gets disabled, so deferrals must be recorded and time-boxed.

## Control flow after the change

```text
pull request
  -> npm ci
  -> lint
  -> test
  -> npm audit --audit-level=high        [NEW]  fails on high/critical
  -> npm run assets:validate              [NEW]  fails on errors, prints warnings
  -> build
  -> playwright install + test:e2e
  -> upload report (on failure)

local:  npm run verify
        = lint && test && assets:validate && test:e2e      [assets:validate added]
```

## Failure handling

- `npm audit` reaching the npm registry is a network dependency. On registry outage the step fails spuriously; either accept that (fail-closed is correct for a security gate) or mark the step `continue-on-error: true` with an explicit follow-up — prefer fail-closed and note it.
- `assets:validate` exits 0 today; if a future asset ships without a provenance sidecar, the validator reports "provenance sidecar missing" as an **error** and the gate fails. That is the intended legal-control behavior.
- The validator imports `../src/assets/manifest.js` directly, so a manifest entry pointing at a missing file fails the gate rather than the game.

## Alternatives considered

- **Fail CI on validator warnings too.** Rejected: the KTX2 warnings are structurally unavoidable for this pipeline and would make the gate permanently red, which trains people to ignore it.
- **Pin `npm audit` to a report artifact instead of failing.** Rejected for the audit (unlike coverage, an unfixed high advisory is a concrete, actionable defect with a one-command fix); warnings-only reporting would be appropriate for a broader, noisier tool.
- **Move asset validation into `build`.** Rejected: the build should transform source, not enforce content policy; keeping it a separate step makes it independently runnable and independently skippable locally.
- **Do the vite major upgrade in this change.** Rejected as out of scope and higher risk than the gate it enables; it is called out as an explicit follow-up with its own verification.
- **Add `--offline`/lockfile-only audit.** Rejected: `npm audit` needs the registry advisory database; there is no offline equivalent.

## Rollout / compatibility

CI-only plus npm aliases and a `package-lock.json` change from the transitive `brace-expansion` bump. No runtime, build-output, or gameplay change. The `verify` script grows one step; anyone running it locally needs the validator's devDependency (`gltf-validator`), which is already a devDependency.

## Testing strategy

This change is verified by the gates themselves:

- Run `npm audit --audit-level=high` before and after the transitive fix; record both results.
- Run `npm run assets:validate` and confirm exit 0 with 0 errors on the current five assets.
- Run `npm run verify` end to end with the new step included.
- Run the full Playwright suite (unchanged) to confirm nothing about the build or asset delivery regressed.
- Confirm each new npm alias actually regenerates its asset by running one and checking `git status` shows either a byte-identical file (proving determinism) or an expected diff.

That last check is worth stating explicitly: it is the only way to know the generation scripts are deterministic enough to be documented as the source of the committed binaries.

## Risks

- A gate that is red on arrival gets disabled. Mitigation: remediate `brace-expansion` in the same change so `npm audit --audit-level=high` is green, and record the vite deferral explicitly.
- Validator warnings accumulate and become noise, hiding a real one. Mitigation: the baseline note lists the known/expected warning classes so a new class is obvious in review.
