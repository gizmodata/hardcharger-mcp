#!/usr/bin/env bash
# Builds the Claude Desktop extension bundle: build/hardcharger-mcp-<version>.mcpb, an
# unversioned build/hardcharger-mcp.mcpb (for a stable "latest" download link), and a
# .sha256 checksum file for each.
#
# Bundle layout:
#   manifest.json, package.json, icon.png, LICENSE, README.md, CHANGELOG.md
#   server/            compiled JS (entry point server/cli.js)
#   node_modules/      production dependencies: all JavaScript, no native code, so the one
#                      bundle runs on every platform Claude Desktop does
#
# Needs the client tarballs in .clients/ (scripts/install-clients.sh), which package-lock.json
# resolves @gizmodata/hardcharger and @gizmodata/chargewire to while they are not on npm.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
MANIFEST_VERSION="$(node -p "require('./manifest.json').version")"
if [ "$MANIFEST_VERSION" != "$VERSION" ]; then
  echo "manifest.json is $MANIFEST_VERSION but package.json is $VERSION: set both" >&2
  exit 1
fi
BUILD_DIR="$ROOT/build"
BUNDLE="$BUILD_DIR/bundle"
OUT="$BUILD_DIR/hardcharger-mcp-${VERSION}.mcpb"

echo "==> Building hardcharger-mcp ${VERSION}"
npm run build

echo "==> Assembling bundle in ${BUNDLE}"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/server"
cp -R dist/. "$BUNDLE/server/"
find "$BUNDLE/server" -name '*.map' -delete
cp LICENSE NOTICE README.md CHANGELOG.md icon.png manifest.json "$BUNDLE/"

# package.json without scripts or bin (nothing runs at install time inside the bundle)
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  delete p.scripts; delete p.bin; delete p.files; delete p.devDependencies;
  p.main = "server/cli.js";
  fs.writeFileSync(process.argv[1], JSON.stringify(p, null, 2) + "\n");
' "$BUNDLE/package.json"
cp package-lock.json "$BUNDLE/"
mkdir -p "$BUNDLE/.clients"
cp .clients/gizmodata-*.tgz "$BUNDLE/.clients/"

echo "==> Installing production dependencies (scripts disabled)"
(cd "$BUNDLE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
# Collect the license texts of exactly the production dependencies shipped below.
(cd "$BUNDLE" && npx --yes license-checker-rseidelsohn@5.0.1 --production --plainVertical > THIRD_PARTY_NOTICES.txt)
test -s "$BUNDLE/THIRD_PARTY_NOTICES.txt"
rm -rf "$BUNDLE/package-lock.json" "$BUNDLE/.clients"

# Nothing native may ship: the bundle is one file for every platform.
native=$(find "$BUNDLE/node_modules" -type f \( -name '*.node' -o -name '*.dylib' -o -name '*.so' -o -name '*.dll' \) | head -5)
if [ -n "$native" ]; then
  echo "native code in the bundle (it must be all JavaScript):" >&2
  echo "$native" >&2
  exit 1
fi
# The bundled client is the pinned one, and the entry point runs under plain Node.
node -e 'const p = require(process.argv[1]); if (p.name !== "@gizmodata/hardcharger") process.exit(1)' \
  "$BUNDLE/node_modules/@gizmodata/hardcharger/package.json"
[ "$(node "$BUNDLE/server/cli.js" --version)" = "$VERSION" ] || { echo "server/cli.js --version is not $VERSION" >&2; exit 1; }

echo "==> Validating manifest and packing"
npx mcpb validate "$BUNDLE/manifest.json"
rm -f "$OUT"
npx mcpb pack "$BUNDLE" "$OUT"

LATEST="$BUILD_DIR/hardcharger-mcp.mcpb"
cp "$OUT" "$LATEST"
(cd "$BUILD_DIR" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256" && shasum -a 256 "$(basename "$LATEST")" > "$(basename "$LATEST").sha256")
echo "==> Wrote $OUT and $LATEST"
cat "$OUT.sha256" "$LATEST.sha256"
