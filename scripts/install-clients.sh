#!/usr/bin/env bash
# Builds the Hardcharger JavaScript client and the Warp SQL client it sits on, at the commits
# pinned in scripts/hardcharger-js.commit and scripts/warp-sql-js.commit, and packs them to
#
#   .clients/gizmodata-warp-sql-<version>.tgz      (gizmodata/warp-sql-js)
#   .clients/gizmodata-hardcharger-<version>.tgz   (gizmodata/hardcharger-js)
#
# Neither package is on npm yet. Until they are, package-lock.json resolves both to these
# tarballs, so `npm ci` installs them from here. package.json (and so the published package)
# keeps naming the npm package @gizmodata/hardcharger and its semver range: the tarballs are a
# development and CI stand-in, never part of what ships. Run this before `npm ci`.
#
#   HARDCHARGER_MCP_WARP_SQL_JS_REPO     where to clone warp-sql-js from
#                                        (default git@github.com:gizmodata/warp-sql-js.git)
#   HARDCHARGER_MCP_HARDCHARGER_JS_REPO  where to clone hardcharger-js from
#                                        (default git@github.com:gizmodata/hardcharger-js.git)
# A local checkout works for either.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
pin() {
  local sha
  sha=$(tr -d '[:space:]' < "$root/scripts/$1.commit")
  if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "scripts/$1.commit must hold one full commit SHA, not '$sha'" >&2
    exit 1
  fi
  printf '%s' "$sha"
}
warp_commit=$(pin warp-sql-js)
hc_commit=$(pin hardcharger-js)
warp_repo="${HARDCHARGER_MCP_WARP_SQL_JS_REPO:-git@github.com:gizmodata/warp-sql-js.git}"
hc_repo="${HARDCHARGER_MCP_HARDCHARGER_JS_REPO:-git@github.com:gizmodata/hardcharger-js.git}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

checkout() { # repo commit dir
  git clone --quiet --no-checkout "$1" "$3"
  git -C "$3" checkout --quiet "$2"
  [ "$(git -C "$3" rev-parse HEAD)" = "$2" ] || { echo "$3 is not at $2" >&2; exit 1; }
}
build() { # dir name
  (
    cd "$1"
    { npm ci --no-audit --no-fund && npm run build && npm pack --pack-destination "$work"; } > "$work/$2.log" 2>&1 ||
      { cat "$work/$2.log" >&2; echo "building $2 failed" >&2; exit 1; }
  )
}

checkout "$warp_repo" "$warp_commit" "$work/warp-sql-js"
checkout "$hc_repo" "$hc_commit" "$work/hardcharger-js"

# hardcharger-js names the warp-sql-js commit it was built and tested on: it must be ours.
theirs=$(tr -d '[:space:]' < "$work/hardcharger-js/scripts/warp-sql-js.commit")
if [ "$theirs" != "$warp_commit" ]; then
  echo "hardcharger-js ${hc_commit:0:7} pins warp-sql-js $theirs, but scripts/warp-sql-js.commit is $warp_commit: pin the same commit" >&2
  exit 1
fi

build "$work/warp-sql-js" warp-sql-js
warp_version=$(node -p 'require(process.argv[1]).version' "$work/warp-sql-js/package.json")
mkdir -p "$work/hardcharger-js/.warp-sql"
cp "$work/gizmodata-warp-sql-$warp_version.tgz" "$work/hardcharger-js/.warp-sql/"
build "$work/hardcharger-js" hardcharger-js
hc_version=$(node -p 'require(process.argv[1]).version' "$work/hardcharger-js/package.json")

if [ -f "$root/package-lock.json" ]; then
  for pair in "warp-sql:$warp_version" "hardcharger:$hc_version"; do
    name="${pair%%:*}" want="${pair#*:}"
    locked=$(node -p "require(process.argv[1]).packages['node_modules/@gizmodata/$name']?.version ?? ''" "$root/package-lock.json")
    if [ -n "$locked" ] && [ "$locked" != "$want" ]; then
      echo "the pinned @gizmodata/$name is $want, but package-lock.json has $locked: update the lock" >&2
      exit 1
    fi
  done
fi

mkdir -p "$root/.clients"
rm -f "$root"/.clients/gizmodata-*.tgz
mv "$work/gizmodata-warp-sql-$warp_version.tgz" "$work/gizmodata-hardcharger-$hc_version.tgz" "$root/.clients/"
echo "@gizmodata/warp-sql $warp_version (warp-sql-js ${warp_commit:0:7}) and @gizmodata/hardcharger $hc_version (hardcharger-js ${hc_commit:0:7}) -> .clients/"
