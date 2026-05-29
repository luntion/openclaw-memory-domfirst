#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
RELEASE_DIR="$ROOT_DIR/release"
STAGE_DIR="$RELEASE_DIR/$NAME-$VERSION"
ARCHIVE_PATH="$RELEASE_DIR/$NAME-$VERSION.tar.gz"

rm -rf "$STAGE_DIR"
rm -f "$ARCHIVE_PATH"
mkdir -p "$STAGE_DIR"

PATHS=(
  "index.ts"
  "service.ts"
  "openclaw.plugin.json"
  "package.json"
  "package-lock.json"
  "README.md"
  "README_CN.md"
  "CHANGELOG.md"
  "LICENSE"
  "tsconfig.json"
  "vitest.config.ts"
  "src"
  "docs"
  "scripts"
)

for path in "${PATHS[@]}"; do
  if [ -e "$path" ]; then
    cp -R "$path" "$STAGE_DIR/$path"
  fi
done

cat > "$STAGE_DIR/release-manifest.json" <<EOF
{
  "name": "$NAME",
  "version": "$VERSION",
  "packagedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

tar -czf "$ARCHIVE_PATH" -C "$RELEASE_DIR" "$NAME-$VERSION"

echo "Created release artifact: $ARCHIVE_PATH"
