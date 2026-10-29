// Runs the live suites (test/live/*.test.ts) against hardcharger-server and decides the
// outcome from node:test's own events, never from its printed output:
//   - without HARDCHARGER_MCP_TEST_SERVER_BINARY (or with one that does not run) it fails;
//   - any failed test, or a file that fails to load, fails the run;
//   - a run in which no test passed fails too, so a suite that silently ran nothing can't
//     turn the gate green. Nothing skips: a skipped or todo test fails the run as well.
//
//   node scripts/run-live.mjs [test/live/one.test.ts ...]
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";

const binary = process.env.HARDCHARGER_MCP_TEST_SERVER_BINARY;
if (!binary) {
  console.error("FAIL: set HARDCHARGER_MCP_TEST_SERVER_BINARY to a hardcharger-server binary; the live tests never skip");
  process.exit(1);
}
try {
  const version = execFileSync(binary, ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH } }).trim();
  console.log(`live tests against ${version} (${binary})`);
} catch (err) {
  console.error(`FAIL: ${binary} --version did not run: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// The suite for a server from before the protocol's rename needs one already running
// (HARDCHARGER_MCP_TEST_OLD_SERVER). On a developer's machine without it, that file is left
// out of a full run, and said so; in CI (CI=true) it always runs, and fails without one.
function leaveOutOldServer(file) {
  if (!file.endsWith("legacy-names-server.test.ts")) return false;
  if (process.env.HARDCHARGER_MCP_TEST_OLD_SERVER || process.env.CI === "true") return false;
  console.log(`leaving out ${file}: HARDCHARGER_MCP_TEST_OLD_SERVER is not set`);
  return true;
}

const files =
  process.argv.length > 2
    ? process.argv.slice(2)
    : readdirSync("test/live")
        .filter((f) => f.endsWith(".test.ts"))
        .sort()
        .map((f) => join("test/live", f))
        .filter((f) => !leaveOutOldServer(f));
if (files.length === 0) {
  console.error("FAIL: no live test files found");
  process.exit(1);
}

let passed = 0;
let failed = 0;
let skipped = 0;
// Files one at a time: several suites start servers and time-based tests shouldn't compete.
const stream = run({ files, concurrency: 1, timeout: 15 * 60_000 });
stream.on("test:pass", (event) => {
  if (event.details?.type === "suite") return;
  if (event.skip || event.todo) skipped++;
  else passed++;
});
stream.on("test:fail", (event) => {
  if (event.details?.type === "suite" && event.details?.error?.failureType === "subtestsFailed") return;
  failed++;
});
stream.compose(spec).pipe(process.stdout);
await new Promise((resolve) => stream.once("end", resolve));

console.log(`\nlive: ${passed} passed, ${failed} failed, ${skipped} skipped, ${files.length} files`);
if (failed > 0) process.exit(1);
if (skipped > 0) {
  console.error("FAIL: live tests must not skip");
  process.exit(1);
}
if (passed === 0) {
  console.error("FAIL: no live test passed (none reached a server)");
  process.exit(1);
}
