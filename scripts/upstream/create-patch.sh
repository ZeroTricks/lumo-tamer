#!/bin/bash
# Create a DEP-3 patch for an upstream lumo file
#
# Usage: ./create-patch.sh <file-path> <description>
#
# Example:
#   ./create-patch.sh indexedDb/db.ts "Fix transaction auto-commit"
#
# The file path is relative to packages/lumo/src/
# Patch name is derived from path: indexedDb/db.ts -> indexedDb-db.patch

set -e

SCRIPT_DIR="$(dirname "$0")"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
UPSTREAM_BASE="https://raw.githubusercontent.com/ProtonMail/WebClients/main/applications/lumo/src/app"
LOCAL_BASE="${REPO_ROOT}/packages/lumo/src"
PATCHES_DIR="${REPO_ROOT}/packages/lumo/patches"

if [ $# -lt 2 ]; then
    echo "Usage: $0 <file-path> <description>"
    echo ""
    echo "Example: $0 indexedDb/db.ts 'Fix transaction issues'"
    echo ""
    echo "Patch name is derived from path: indexedDb/db.ts -> indexedDb-db.patch"
    exit 1
fi

FILE_PATH="$1"
DESCRIPTION="$2"
# Convert path to patch name: indexedDb/db.ts -> indexedDb-db.patch
PATCH_NAME=$(echo "$FILE_PATH" | sed 's|/|-|g; s|\.ts$||').patch
PATCH_FILE="${PATCHES_DIR}/${PATCH_NAME}"

LOCAL_FILE="${LOCAL_BASE}/${FILE_PATH}"
if [ ! -f "$LOCAL_FILE" ]; then
    echo "Error: Local file not found: $LOCAL_FILE"
    exit 1
fi

# Download pristine upstream
TEMP_FILE=$(mktemp)
trap 'rm -f "$TEMP_FILE"' EXIT

echo "Downloading upstream ${FILE_PATH}..."
curl -sL "${UPSTREAM_BASE}/${FILE_PATH}" > "$TEMP_FILE"

if [ ! -s "$TEMP_FILE" ]; then
    echo "Error: Failed to download upstream file"
    exit 1
fi

# Create patch with DEP-3 header
echo "Creating patch: ${PATCH_FILE}"

cat > "$PATCH_FILE" << EOF
Description: ${DESCRIPTION}
Origin: vendor
---
 ${FILE_PATH} | 0 +
 1 file changed

diff --git a/${FILE_PATH} b/${FILE_PATH}
EOF

# Append the diff
diff -u "$TEMP_FILE" "$LOCAL_FILE" \
    | sed "1s|.*|--- a/${FILE_PATH}|; 2s|.*|+++ b/${FILE_PATH}|" \
    >> "$PATCH_FILE" || true

# Verify
echo ""
echo "Verifying patch..."
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR" "$TEMP_FILE"' EXIT

mkdir -p "$TEMP_DIR/$(dirname "$FILE_PATH")"
cp "$TEMP_FILE" "$TEMP_DIR/${FILE_PATH}"

if patch -d "$TEMP_DIR" -p1 --dry-run < "$PATCH_FILE" > /dev/null 2>&1; then
    echo "Patch applies cleanly."
    echo ""
    echo "Next steps:"
    echo "  1. Edit ${PATCH_FILE} to improve the Description"
    echo "  2. Add '${PATCH_NAME}' to packages/lumo/patches/series"
else
    echo "Warning: Patch may not apply cleanly. Check the output."
fi
