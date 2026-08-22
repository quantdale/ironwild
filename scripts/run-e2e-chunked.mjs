// IRONWILD chunked E2E driver (verification campaign).
//
// Why this exists: one long serialized playwright run degrades on this
// machine - late specs time out on trivially-green interactions because the
// host fatigues (thermal/CPU pressure from ~50 minutes of continuous
// software-GL rendering), not because the game regressed. Evidence: an
// authoritative 22-spec run failed its entire tail including specs that pass
// deterministically when run fresh (start-move, settings-quality).
//
// What it does:
//   1. builds once (`npm run build`) so no stale dist/preview trap;
//   2. frees port 4173 if a previous preview server still holds it;
//   3. runs the suite in CHUNKS - each chunk is a separate playwright
//      process (fresh browser + workers), same one-worker serialization
//      inside the chunk;
//   4. between chunks, kills only PLAYWRIGHT-LAUNCHED browsers (command
//      line contains the ms-playwright cache path) - the user's own browser
//      is never touched;
//   5. prints a per-chunk verdict table and exits non-zero if any chunk
//      failed.
//
// Usage:
//   node scripts/run-e2e-chunked.mjs            # all chunks
//   node scripts/run-e2e-chunked.mjs A C        # only chunks A and C
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const CHUNKS = {
  // Fast boot/movement/pickup basics first - they anchor the environment.
  A: [
    "tests/e2e/boot.spec.js",
    "tests/e2e/start-move.spec.js",
    "tests/e2e/pickup.spec.js",
  ],
  // Combat + persistence + the pointer-lock lifecycle pair.
  B: [
    "tests/e2e/combat-smoke.spec.js",
    "tests/e2e/save-continue.spec.js",
    "tests/e2e/pause-resume.spec.js",
  ],
  // Panel/UI-heavy specs incl. the two longest (clean-session, quality reload).
  C: [
    "tests/e2e/inventory-craft.spec.js",
    "tests/e2e/settings-quality.spec.js",
    "tests/e2e/clean-session.spec.js",
  ],
  // New-architecture specs (telemetry/dynres/rebind/animator lifecycle).
  D: [
    "tests/e2e/telemetry.spec.js",
    "tests/e2e/dynres.spec.js",
    "tests/e2e/input-rebind.spec.js",
    "tests/e2e/a11y-lifecycle.spec.js",
  ],
};

const wanted = process.argv.slice(2);
const ids = wanted.length ? wanted : Object.keys(CHUNKS);
for (const id of ids) {
  if (!CHUNKS[id]) {
    console.error(
      `unknown chunk '${id}' (have ${Object.keys(CHUNKS).join(" ")})`,
    );
    process.exit(2);
  }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    shell: process.platform === "win32",
    stdio: opts.capture ? "pipe" : "inherit",
    encoding: "utf8",
    ...opts.spawn,
  });
  return {
    ok: r.status === 0,
    out: `${r.stdout || ""}${r.stderr || ""}`,
    status: r.status,
  };
}

// Multi-line scripts CANNOT go through `-Command` when the grandparent shell
// is anything but cmd (git-bash mangles newlines -> "a command must follow
// -Command" and the sweep silently no-ops). A temp .ps1 file works everywhere.
function powershell(script) {
  const dir = mkdtempSync(join(tmpdir(), "iw-chunked-"));
  const file = join(dir, "sweep.ps1");
  writeFileSync(file, script, "utf8");
  try {
    return run(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file],
      {
        capture: true,
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Kill only browsers launched from the playwright cache (never user Chrome). */
function killPlaywrightBrowsers() {
  const ps = `
    $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='headless_shell.exe' OR Name='msedge.exe'" |
      Where-Object { $_.CommandLine -match 'ms-playwright' }
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    "$($procs | Measure-Object).Count killed"`;
  const r = powershell(ps);
  console.log(`[chunked] playwright-browser sweep: ${(r.out || "").trim()}`);
}

/** Free :4173 if a stale preview server is listening (the stale-dist trap). */
function freePreviewPort() {
  const ps = `
    $conns = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
      if ($p.CommandLine -match 'vite|preview|node') {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Output ("killed stale server pid " + $c.OwningProcess)
      } else {
        Write-Output ("port 4173 held by pid " + $c.OwningProcess + " (not vite/node) - leaving it")
      }
    }`;
  const r = powershell(ps);
  console.log(
    `[chunked] port check: ${(r.out || "").trim() || "port 4173 free"}`,
  );
}

console.log("[chunked] building production bundle...");
const build = run("npm", ["run", "build"]);
if (!build.ok) {
  console.error(build.out);
  console.error("[chunked] build FAILED - aborting before any chunk.");
  process.exit(1);
}

freePreviewPort();

const results = [];
for (const id of ids) {
  const files = CHUNKS[id];
  console.log(`\n[chunked] ===== chunk ${id}: ${files.length} spec(s) =====`);
  const t0 = Date.now();
  const r = run("npx", ["playwright", "test", ...files, "--reporter=list"], {
    capture: true,
  });
  process.stdout.write(r.out);
  const secs = Math.round((Date.now() - t0) / 1000);
  results.push({ id, files: files.length, ok: r.ok, secs });
  console.log(`[chunked] chunk ${id} -> ${r.ok ? "PASS" : "FAIL"} (${secs}s)`);
  killPlaywrightBrowsers();
}

console.log("\n[chunked] ========== summary ==========");
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(
    `  chunk ${r.id}: ${r.ok ? "PASS" : "FAIL"} (${r.files} specs, ${r.secs}s)`,
  );
}
const totalSecs = results.reduce((a, r) => a + r.secs, 0);
console.log(
  `[chunked] ${results.length - failed}/${results.length} chunks green in ${totalSecs}s`,
);
process.exit(failed ? 1 : 0);
