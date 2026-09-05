#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

echo "Building frontend..."
npm run build

PLUGIN_NAME=$(node -p "require('./plugin.json').name")
echo "Plugin name: $PLUGIN_NAME"

STAGE_DIR="$(mktemp -d)"
TARGET_DIR="$STAGE_DIR/$PLUGIN_NAME"
mkdir -p "$TARGET_DIR"

cp plugin.json main.py package.json "$TARGET_DIR/"
cp -r dist "$TARGET_DIR/"

OUTPUT_ZIP="$PROJECT_DIR/${PLUGIN_NAME}.zip"
rm -f "$OUTPUT_ZIP"

(
  cd "$STAGE_DIR"
  zip -r "$OUTPUT_ZIP" "$PLUGIN_NAME" > /dev/null
)

rm -rf "$STAGE_DIR"

echo "Done: $OUTPUT_ZIP"
