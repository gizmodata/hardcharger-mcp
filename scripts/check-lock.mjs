// Checks how the Hardcharger client is installed while it is not on npm
// (scripts/install-clients.sh):
//
//   - package.json names @gizmodata/hardcharger with a semver range (that is what ships),
//     never a tarball, a path or a git URL, and does not name @gizmodata/chargewire (it comes
//     with @gizmodata/hardcharger);
//   - package-lock.json resolves both to .clients/gizmodata-<name>-<version>.tgz, with no
//     integrity hash (the tarballs are rebuilt from the pinned commits on each machine, so
//     their bytes may differ), and the root lists the same range as package.json.
//
// `--fix` repairs both after `npm install ./.clients/*.tgz` (how the lock is made again after
// a repin): it puts the range ^<version> back and drops chargewire from the root.
import { readFileSync, writeFileSync } from "node:fs";

const fix = process.argv.includes("--fix");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const problems = [];
const range = /^[\^~]?\d+\.\d+\.\d+$/u;
const root = lock.packages?.[""];

for (const name of ["@gizmodata/hardcharger", "@gizmodata/chargewire"]) {
  const entry = lock.packages?.[`node_modules/${name}`];
  if (entry === undefined) {
    console.error(`package-lock.json has no ${name}: run scripts/install-clients.sh, then npm install the tarballs`);
    process.exit(1);
  }
  const wanted = `file:.clients/${name.replace("@gizmodata/", "gizmodata-")}-${entry.version}.tgz`;
  if (entry.resolved !== wanted) problems.push(`package-lock.json: ${name} resolves to ${entry.resolved}, not ${wanted}`);
  if (fix) delete entry.integrity;
  if (entry.integrity !== undefined) problems.push(`package-lock.json: ${name} must have no integrity hash`);

  if (name === "@gizmodata/hardcharger") {
    let spec = pkg.dependencies?.[name];
    if (fix && !range.test(spec ?? "")) spec = pkg.dependencies[name] = `^${entry.version}`;
    if (!range.test(spec ?? "")) problems.push(`package.json: ${name} must be a semver range like ^2.0.0, not ${spec}`);
    if (fix) root.dependencies[name] = spec;
    if (root?.dependencies?.[name] !== spec) {
      problems.push(`package-lock.json: the root's ${name} must be ${spec}, as in package.json`);
    }
  } else {
    if (fix) {
      delete pkg.dependencies[name];
      delete root.dependencies[name];
    }
    if (pkg.dependencies?.[name] !== undefined || root?.dependencies?.[name] !== undefined) {
      problems.push(`${name} must not be a direct dependency: it comes with @gizmodata/hardcharger`);
    }
  }
}

if (fix) {
  writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
}
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log("@gizmodata/hardcharger and @gizmodata/chargewire: package-lock.json resolves them to .clients/ tarballs");
