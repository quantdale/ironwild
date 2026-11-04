## Why

The repository has no dependency-security gate, and `npm audit` reports **3 live vulnerabilities (1 moderate, 2 high)** in the current tree — `brace-expansion` (quadratic-time DoS / stack exhaustion) and `esbuild`/`vite` (dev-server request reflection) — with a fix available via `npm audit fix`. The same gap exists for authored assets: the repo now ships **5 authored GLB files with provenance sidecars**, and a real validator (`npm run assets:validate`, using the official Khronos glTF validator) exists, but it runs in **neither** CI nor `npm run verify`. A malformed, unlicensed, or convention-violating asset — or a vulnerable dependency — merges green today. Asset-generation scripts are also mostly not exposed as npm commands, so assets cannot be regenerated from the documented workflow.

## What Changes

- **Add a dependency-security gate to CI** that fails on high/critical advisories, and remediate the advisories currently present. This change is the only owner of that CI step.
- **Add the asset validator to CI and to `npm run verify`**, so authored assets are validated on every change like any other source artifact. `harden-core-verification` must not add a second copy of this step.
- **Fail CI on the validator's hard errors; surface its warnings.** Errors already fail the validator; warnings (which include Khronos notices that are expected for KTX2 textures and for the certification prop) must be visible in the job log without failing the build, so real regressions are not lost in noise.
- **Expose the asset-generation scripts as npm commands** so every shipped asset is reproducible from documented commands, matching the existing `assets:create-cert`.
- **Record the audit baseline.** Record the current advisory state and the decision about each class of finding, so the gate's threshold is a documented choice rather than an accident.
- No runtime/gameplay changes; the validator and audit operate on the repository and its dependency tree.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
<!-- None. -->

Non-behavioral: this change adds CI gates, dependency remediation, and npm-script aliases. It is marked `skip_specs: true` in `.openspec.yaml`.

## Impact

- Affected files: `.github/workflows/ci.yml`, `package.json` (script aliases; devDependency bumps), `package-lock.json`, and a new short `docs/` note recording the audit baseline and validator expectations.
- The validator depends on the `gltf-validator` devDependency, which is already installed and already runs cleanly on the current five assets.
- CI runtime: the validator and audit are fast and run in the existing unit job; no added browser/E2E time.
- Player-visible impact: none directly; indirectly, a gated validator prevents a broken asset from shipping.
