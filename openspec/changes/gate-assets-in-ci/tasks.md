# Tasks — Gate assets and dependencies in CI (tooling)

## 0. Cross-change coordination (read before editing)

This change edits `.github/workflows/ci.yml` and `package.json`. Sibling changes that also touch them:

- **This change is the sole owner of the CI dependency-audit step, the CI asset-validation step, and the `assets:validate` insertion into `verify`.** `harden-core-verification` must not add those. It may add a separate `test:coverage` script; do not fold that script into `verify` and do not remove it if it has already landed. Re-read `ci.yml` and `package.json` before editing.
- **`sync-project-documentation`** edits `README.md` (quality-gate list) to reflect the new gate; apply it after this change so the documented gate matches what actually runs.
- **`restore-machine-combat-visuals`** extends `tests/e2e/asset-pipeline.spec.js`; this change only references it (no edit), so no conflict.

## 1. Remediate the current dependency advisories

- [ ] 1.1 Record the pre-change audit result as the baseline: `npm audit --audit-level=high` currently reports 3 advisories (2 high `brace-expansion`, 1 moderate `esbuild`/`vite`) and exits non-zero.
- [ ] 1.2 Run `npm audit fix` to take the semver-compatible `brace-expansion` transitive bump; confirm `npm audit --audit-level=high` now exits 0.
- [ ] 1.3 Re-run `npm run build` and `npm test` after the lockfile change and confirm both are unaffected (the bump is transitive/build-time only).
- [ ] 1.4 Do **not** perform the `vite` major upgrade (past 6.4.2) in this change. Record it in the baseline note (section 5) as a deferred item with its reason: `vite ^5.4.0` → the fix requires crossing a major boundary that affects `vite.config.js` (`manualChunks`, the vitest `test` block), `test:e2e`'s use of `vite preview`, and build chunking.
- [ ] 1.5 Note in the baseline that the residual `esbuild`/`vite` advisory affects the **development server only** and cannot affect the production build artifact or player runtime, so deferring it does not leave a player-facing exposure.

## 2. Add the CI gates

- [ ] 2.1 In `.github/workflows/ci.yml`, add a `Dependency audit` step running `npm audit --audit-level=high`; place it in the fast job after `npm test` and before the browser-dependent steps.
- [ ] 2.2 Add an `Asset validation` step running `npm run assets:validate` in the same fast job.
- [ ] 2.3 Confirm the audit step fails the job on a high/critical advisory without extra scripting (verify the exit-code behavior on a deliberately-broken lockfile in a scratch copy, or confirm from npm's documented exit-code contract and record the reasoning).
- [ ] 2.4 Decide and document whether the audit step is fail-closed on registry outage; prefer fail-closed and record the decision.
- [ ] 2.5 Do not reorder or alter the existing lint → unit → build → e2e sequence, and do not lengthen the E2E job.
- [ ] 2.6 Verify the validator's exit semantics are relied on correctly: errors → exit 1 (fatal), warnings → printed, exit 0. Do not add warning-as-failure.

## 3. Align the local gate with CI

- [ ] 3.1 In `package.json`, change `verify` to `npm run lint && npm test && npm run assets:validate && npm run test:e2e` so the local gate matches CI.
- [ ] 3.2 Confirm the validator's `gltf-validator` devDependency is present and documented as required for `verify` (it is already a devDependency).
- [ ] 3.3 Run `npm run verify` end to end and confirm it passes with the new step.

## 4. Expose asset-generation commands

- [ ] 4.1 In `package.json`, add `assets:create-hunter` → `node scripts/create-hunter-asset.mjs`.
- [ ] 4.2 Add `assets:create-skitter` → `node scripts/create-skitter-asset.mjs`.
- [ ] 4.3 Add `assets:create-machines` → `node scripts/create-machines-assets.mjs`.
- [ ] 4.4 Keep `assets:create-cert` (wayshrine) as-is.
- [ ] 4.5 Do **not** add a catch-all `assets:create-all` and do not wire generation into `build`/`verify` — assets are committed source, generated deliberately.
- [ ] 4.6 Determinism check: run at least one of the new aliases and confirm `git status` shows either a byte-identical file (proving deterministic output) or an explainable diff. Record the result; if a generator is non-deterministic, say so in the baseline note rather than hiding it.
- [ ] 4.7 Confirm each alias regenerates its provenance sidecar as well as the binary (the validator requires the sidecar, so a partial regeneration must fail loudly).

## 5. Baseline documentation

- [ ] 5.1 Create `docs/ASSET-GATES.md` recording: the pre-change audit result, the post-remediation result, and the deferred `vite` item with its reason and the dev-server-only severity note.
- [ ] 5.2 Document the validator contract: what is fatal (errors), what is a warning, and why the KTX2 (`image/ktx2` / "Image format not recognized") and "Empty node encountered" warnings are expected for this pipeline.
- [ ] 5.3 Note that KTX2 correctness is proven at runtime by `tests/e2e/asset-pipeline.spec.js` (it asserts the decoded texture is a real `DataTexture` of the expected size), which is why the Khronos inability to validate `KHR_texture_basisu` is not a coverage gap.
- [ ] 5.4 Add the regeneration command table (from task 4) so the README can link to it.
- [ ] 5.5 State the operating rule: a gate that is permanently red gets disabled, so any deferral must be recorded and revisited; a new warning class in validator output is a review signal, not noise to ignore.

## 6. Verification

- [ ] 6.1 `npm audit --audit-level=high` exits 0 after remediation.
- [ ] 6.2 `npm run assets:validate` exits 0 with 0 errors on the five current assets.
- [ ] 6.3 `npm run lint` clean; `npm test` passes; `npm run build` succeeds.
- [ ] 6.4 `npm run verify` passes end to end including the new step.
- [ ] 6.5 `npx playwright test` — full suite green (the build artifact is unaffected by a transitive devDependency bump, but confirm).
- [ ] 6.6 Confirm the CI workflow file is valid YAML and the step ordering is correct by reading the final diff.
- [ ] 6.7 `git status` shows only CI config, `package.json`/`package-lock.json`, and docs changed — no `src/` or `public/assets/` content changes unless a determinism check regenerated a byte-identical file.
