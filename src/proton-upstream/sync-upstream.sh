#!/bin/bash
#
# Sync upstream changes from Proton WebClients repository
# Usage: npm run sync-upstream (must be run from project root)
#
# Fetches files directly from GitHub without requiring a local clone.
#

set -e

# Verify we're in project root
if [ ! -f "package.json" ] || [ ! -d "src/proton-upstream" ]; then
    echo "Error: Must be run from project root via 'npm run sync-upstream'"
    exit 1
fi

# Configuration
UPSTREAM_REPO="ProtonMail/WebClients"
UPSTREAM_BRANCH="main"
UPSTREAM_DIR="src/proton-upstream"
UPSTREAM_BASE_URL="https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_BRANCH}/applications/lumo/src/app"
GITHUB_API="https://api.github.com/repos/${UPSTREAM_REPO}"

# Temp directory for downloads
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Files to sync (paths match upstream structure exactly)
UPSTREAM_FILES=(
    # Core API client
    lib/lumo-api-client/core/encryption.ts
    lib/lumo-api-client/core/streaming.ts
    lib/lumo-api-client/core/types.ts
    keys.ts
    crypto/types.ts

    # Remote API
    remote/api.ts
    remote/types.ts
    remote/conversion.ts
    remote/scheduler.ts
    remote/util.ts

    # Utilities
    util/collections.ts
    util/date.ts
    util/objects.ts
    util/sorting.ts
    util/nullable.ts
    util/base64.ts
    util/safeLogger.ts

    # Types
    types.ts
    types-api.ts

    # Serialization
    serialization.ts
    messageHelpers.ts

    # IndexedDB
    indexedDb/db.ts
    indexedDb/util.ts
    helpers/indexedDBVersionHandler.ts

    # Redux slices
    redux/slices/core/index.ts
    redux/slices/core/spaces.ts
    redux/slices/core/conversations.ts
    redux/slices/core/messages.ts
    redux/slices/core/attachments.ts
    redux/slices/core/idmap.ts
    redux/slices/core/credentials.ts
    redux/slices/meta/initialization.ts
    redux/slices/attachmentLoadingState.ts
    redux/slices/lumoUserSettings.ts

    # Redux core (patched)
    redux/rootReducer.ts
    redux/store.ts

    # Redux sagas
    redux/sagas/index.ts
    redux/sagas/conversations.ts
    redux/sagas/messages.ts
    redux/sagas/spaces.ts
    redux/sagas/idmap.ts
    redux/sagas/attachments.ts

    # Redux (patched)
    redux/selectors.ts

    # Services
    services/attachmentDataCache.ts
    services/search/searchService.ts
)

# Local shim files (not in UPSTREAM_FILES, never overwritten):
#   config.ts             - APP_NAME, APP_VERSION constants
#   crypto/index.ts       - Crypto using @proton/* shims
#   redux/sagas.ts        - ClientError, ConflictClientError
#   redux/slices/index.ts - Removes UI slices (ghostChat, contextFilters, etc.)
#   indexeddb-polyfill.ts - Node.js IndexedDB polyfill

echo -e "${BLUE}=== Proton WebClients Upstream Sync ===${NC}\n"

# Get latest commit info
echo -e "Fetching latest upstream commit..."
LATEST_COMMIT=$(curl -sL "${GITHUB_API}/commits/${UPSTREAM_BRANCH}" | grep -oP '"sha":\s*"\K[a-f0-9]+' | head -1)

if [ -z "$LATEST_COMMIT" ]; then
    echo -e "${RED}Failed to fetch commit info from GitHub API${NC}"
    echo "This might be due to rate limiting. Try again later."
    exit 1
fi

echo -e "Latest commit: ${GREEN}${LATEST_COMMIT:0:12}${NC}"

# Download a file from upstream
download_file() {
    local upstream_path="$1"
    local output_file="$2"
    local url="${UPSTREAM_BASE_URL}/${upstream_path}"

    if curl -sfL -o "$output_file" "$url"; then
        # Check if we got a valid file (not a 404 page)
        if [ -s "$output_file" ] && ! grep -q "^404:" "$output_file" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

# Download all upstream files to temp
echo -e "\n${BLUE}Downloading upstream files...${NC}"
for file_path in "${UPSTREAM_FILES[@]}"; do
    temp_file="${TEMP_DIR}/${file_path}"
    mkdir -p "$(dirname "$temp_file")"

    if download_file "$file_path" "$temp_file"; then
        echo -e "  ${GREEN}✓${NC} $file_path"
    else
        echo -e "  ${RED}✗${NC} $file_path (download failed)"
    fi
done

# Check for changes
echo -e "\n${BLUE}Comparing with local files...${NC}"
declare -a CHANGED_FILES=()
declare -a MISSING_FILES=()

for file_path in "${UPSTREAM_FILES[@]}"; do
    local_file="${UPSTREAM_DIR}/${file_path}"
    temp_file="${TEMP_DIR}/${file_path}"

    if [ ! -f "$temp_file" ]; then
        continue
    fi

    if [ -f "$local_file" ]; then
        if diff -q "$temp_file" "$local_file" >/dev/null 2>&1; then
            echo -e "  ${GREEN}=${NC} $file_path (up to date)"
        else
            echo -e "  ${YELLOW}~${NC} $file_path (changes available)"
            CHANGED_FILES+=("$file_path")
        fi
    else
        echo -e "  ${RED}!${NC} $file_path (missing locally)"
        MISSING_FILES+=("$file_path")
    fi
done

# Check APP_VERSION specifically (important for x-pm-appversion header)
# config.ts is a shim locally, so we download upstream version just for version comparison
UPSTREAM_CONFIG_TEMP="${TEMP_DIR}/_upstream_config.ts"
if curl -sfL -o "$UPSTREAM_CONFIG_TEMP" "${UPSTREAM_BASE_URL}/config.ts" 2>/dev/null; then
    UPSTREAM_VERSION=$(grep -oP "APP_VERSION\s*=\s*'\\K[^']+" "$UPSTREAM_CONFIG_TEMP" 2>/dev/null || echo "")
    LOCAL_VERSION=$(grep -oP "APP_VERSION\s*=\s*'\\K[^']+" "${UPSTREAM_DIR}/config.ts" 2>/dev/null || echo "")
    if [ -n "$UPSTREAM_VERSION" ] && [ "$UPSTREAM_VERSION" != "$LOCAL_VERSION" ]; then
        echo -e "\n${YELLOW}⚠ APP_VERSION changed upstream: ${LOCAL_VERSION} -> ${UPSTREAM_VERSION}${NC}"
        echo -e "  Update src/proton-upstream/config.ts if needed."
    fi
fi

# Check shim source files for upstream changes
# Shims replace upstream files with local implementations - warn if upstream changes
echo -e "\n${BLUE}Checking shim source files...${NC}"
SHIM_HASH_FILE="${UPSTREAM_DIR}/.shim-hashes"

# Shim files and their upstream paths
declare -A SHIM_SOURCES=(
    ["config.ts"]="config.ts"
    ["crypto/index.ts"]="crypto/index.ts"
    ["redux/sagas.ts"]="redux/sagas.ts"
    ["redux/slices/index.ts"]="redux/slices/index.ts"
)

for shim_path in "${!SHIM_SOURCES[@]}"; do
    upstream_path="${SHIM_SOURCES[$shim_path]}"
    temp_file="${TEMP_DIR}/_shim_${shim_path//\//_}"

    if curl -sfL -o "$temp_file" "${UPSTREAM_BASE_URL}/${upstream_path}" 2>/dev/null; then
        NEW_HASH=$(sha256sum "$temp_file" | cut -d' ' -f1)
        OLD_HASH=$(grep "^${shim_path} " "$SHIM_HASH_FILE" 2>/dev/null | cut -d' ' -f2)

        if [ -z "$OLD_HASH" ]; then
            echo -e "  ${YELLOW}!${NC} $shim_path (no stored hash)"
            echo "$shim_path $NEW_HASH" >> "$SHIM_HASH_FILE"
        elif [ "$NEW_HASH" != "$OLD_HASH" ]; then
            echo -e "  ${YELLOW}⚠${NC} $shim_path changed upstream - review shim"
        else
            echo -e "  ${GREEN}=${NC} $shim_path (no changes)"
        fi
    else
        echo -e "  ${RED}✗${NC} $shim_path (download failed)"
    fi
done

# Check adapted (not 1:1) upstream files for changes
echo -e "\n${BLUE}Checking adapted upstream sources...${NC}"
ADAPTED_HASH_FILE="${UPSTREAM_DIR}/.adapted-hashes"
ADAPTED_MOCK_URL="${UPSTREAM_BASE_URL}/mocks/handlers.ts"
ADAPTED_MOCK_TEMP="${TEMP_DIR}/_adapted_handlers.ts"
if curl -sfL -o "$ADAPTED_MOCK_TEMP" "$ADAPTED_MOCK_URL" 2>/dev/null; then
    NEW_HASH=$(sha256sum "$ADAPTED_MOCK_TEMP" | cut -d' ' -f1)
    OLD_HASH=$(grep "^mocks/handlers.ts " "$ADAPTED_HASH_FILE" 2>/dev/null | cut -d' ' -f2)

    if [ -z "$OLD_HASH" ]; then
        echo -e "  ${YELLOW}!${NC} mocks/handlers.ts (no stored hash)"
        echo "mocks/handlers.ts $NEW_HASH" >> "$ADAPTED_HASH_FILE"
    elif [ "$NEW_HASH" != "$OLD_HASH" ]; then
        echo -e "  ${YELLOW}⚠${NC} mocks/handlers.ts changed upstream"
        echo -e "    Review changes and update src/mock/mock-api.ts if needed."
    else
        echo -e "  ${GREEN}=${NC} mocks/handlers.ts (no changes)"
    fi
else
    echo -e "  ${RED}✗${NC} mocks/handlers.ts (download failed)"
fi

# Apply patches from patches/series
apply_patches() {
    local patches_dir="${UPSTREAM_DIR}/patches"
    local series_file="${patches_dir}/series"

    if [ ! -f "$series_file" ]; then
        echo -e "  ${YELLOW}!${NC} No patches/series file found"
        return 0
    fi

    echo -e "\n${BLUE}Applying patches...${NC}"
    local applied=0
    local failed=0

    while IFS= read -r line || [ -n "$line" ]; do
        # Skip empty lines and comments
        [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

        # Extract patch name (strip comments and whitespace)
        local patch_name
        patch_name=$(echo "$line" | sed 's/#.*$//' | xargs)
        [[ -z "$patch_name" ]] && continue

        local patch_file="${patches_dir}/${patch_name}"
        if [ ! -f "$patch_file" ]; then
            echo -e "  ${RED}!${NC} $patch_name (file not found)"
            ((failed++))
            continue
        fi

        # Apply patch (--forward skips already applied, -s is silent)
        if patch -d "$UPSTREAM_DIR" -p1 --forward -s < "$patch_file" 2>/dev/null; then
            echo -e "  ${GREEN}+${NC} $patch_name"
            ((applied++))
        elif patch -d "$UPSTREAM_DIR" -p1 --forward -s --dry-run < "$patch_file" 2>/dev/null; then
            echo -e "  ${GREEN}=${NC} $patch_name (already applied)"
        else
            echo -e "  ${RED}!${NC} $patch_name (failed)"
            ((failed++))
        fi
    done < "$series_file"

    if [ $applied -gt 0 ] || [ $failed -gt 0 ]; then
        echo -e "  Applied: $applied, Failed: $failed"
    fi
}

# Show patch status
show_patches() {
    local patches_dir="${UPSTREAM_DIR}/patches"
    local series_file="${patches_dir}/series"

    if [ ! -f "$series_file" ]; then
        echo -e "\n${YELLOW}No patches/series file found${NC}"
        return
    fi

    echo -e "\n${BLUE}=== Patches ===${NC}"
    while IFS= read -r line || [ -n "$line" ]; do
        # Skip empty lines
        [[ -z "$line" ]] && continue

        # Handle comments
        if [[ "$line" =~ ^[[:space:]]*# ]]; then
            echo -e "  ${YELLOW}#${NC} ${line#*#}"
            continue
        fi

        local patch_name
        patch_name=$(echo "$line" | sed 's/#.*$//' | xargs)
        [[ -z "$patch_name" ]] && continue

        local patch_file="${patches_dir}/${patch_name}"
        if [ -f "$patch_file" ]; then
            # Show DEP-3 Description if present
            local desc
            desc=$(grep -m1 "^Description:" "$patch_file" 2>/dev/null | sed 's/^Description:[[:space:]]*//')
            if [ -n "$desc" ]; then
                echo -e "  ${GREEN}✓${NC} $patch_name"
                echo -e "      ${desc}"
            else
                echo -e "  ${GREEN}✓${NC} $patch_name"
            fi
        else
            echo -e "  ${RED}!${NC} $patch_name (missing)"
        fi
    done < "$series_file"
}

# Interactive menu
show_menu() {
    echo -e "\n${BLUE}=== Options ===${NC}"
    echo "  1) Show diff for changed files"
    echo "  2) Sync all upstream files"
    echo "  3) Sync specific file"
    echo "  4) Show recent upstream commits"
    echo "  5) Test build"
    echo "  6) Show patches"
    echo "  q) Quit"
    echo ""
}

show_diffs() {
    if [ ${#CHANGED_FILES[@]} -eq 0 ]; then
        echo -e "\n${GREEN}No changes detected${NC}"
        return
    fi

    for local_path in "${CHANGED_FILES[@]}"; do
        local_file="${UPSTREAM_DIR}/${local_path}"
        temp_file="${TEMP_DIR}/${local_path}"

        echo -e "\n${YELLOW}=== $local_path ===${NC}"
        diff -u "$local_file" "$temp_file" 2>/dev/null | head -60 || true

        total=$(diff "$local_file" "$temp_file" 2>/dev/null | wc -l)
        if [ "$total" -gt 60 ]; then
            echo -e "${YELLOW}... ($total total lines, truncated)${NC}"
        fi
    done
}

sync_all_files() {
    echo -e "\n${BLUE}Syncing all upstream files...${NC}"
    for file_path in "${UPSTREAM_FILES[@]}"; do
        local_file="${UPSTREAM_DIR}/${file_path}"
        temp_file="${TEMP_DIR}/${file_path}"

        if [ -f "$temp_file" ]; then
            mkdir -p "$(dirname "$local_file")"
            cp "$temp_file" "$local_file"
            echo -e "  ${GREEN}✓${NC} $file_path"
        fi
    done

    # Update upstream.md with new commit
    if [ -f "docs/upstream.md" ]; then
        sed -i "s/\*\*Commit:\*\* [a-f0-9]*/\*\*Commit:\*\* ${LATEST_COMMIT}/" "docs/upstream.md"
        sed -i "s/\*\*Sync Date:\*\* [0-9-]*/\*\*Sync Date:\*\* $(date +%Y-%m-%d)/" "docs/upstream.md"
        echo -e "  ${GREEN}✓${NC} Updated docs/upstream.md"
    fi

    # Update shim source hashes
    SHIM_HASH_FILE="${UPSTREAM_DIR}/.shim-hashes"
    for shim_path in config.ts crypto/index.ts redux/sagas.ts redux/slices/index.ts; do
        temp_file="${TEMP_DIR}/_shim_${shim_path//\//_}"
        if [ -f "$temp_file" ]; then
            NEW_HASH=$(sha256sum "$temp_file" | cut -d' ' -f1)
            if grep -q "^${shim_path} " "$SHIM_HASH_FILE" 2>/dev/null; then
                sed -i "s|^${shim_path} .*|${shim_path} $NEW_HASH|" "$SHIM_HASH_FILE"
            else
                echo "$shim_path $NEW_HASH" >> "$SHIM_HASH_FILE"
            fi
        fi
    done
    echo -e "  ${GREEN}✓${NC} Updated shim source hashes"

    # Update adapted file hashes
    ADAPTED_HASH_FILE="${UPSTREAM_DIR}/.adapted-hashes"
    ADAPTED_MOCK_TEMP="${TEMP_DIR}/_adapted_handlers.ts"
    if [ -f "$ADAPTED_MOCK_TEMP" ]; then
        NEW_HASH=$(sha256sum "$ADAPTED_MOCK_TEMP" | cut -d' ' -f1)
        if grep -q "^mocks/handlers.ts " "$ADAPTED_HASH_FILE" 2>/dev/null; then
            sed -i "s|^mocks/handlers.ts .*|mocks/handlers.ts $NEW_HASH|" "$ADAPTED_HASH_FILE"
        else
            echo "mocks/handlers.ts $NEW_HASH" >> "$ADAPTED_HASH_FILE"
        fi
        echo -e "  ${GREEN}✓${NC} Updated adapted file hashes"
    fi

    # Apply patches after syncing pristine files
    apply_patches

    echo -e "\n${GREEN}Sync complete!${NC}"
    echo -e "Run ${YELLOW}npm run build${NC} to verify."
}

sync_specific_file() {
    echo -e "\nSelect file to sync:"
    local all_files=("${UPSTREAM_FILES[@]}")
    select local_path in "${all_files[@]}" "Cancel"; do
        if [ "$local_path" = "Cancel" ]; then
            break
        elif [ -n "$local_path" ]; then
            local_file="${UPSTREAM_DIR}/${local_path}"
            temp_file="${TEMP_DIR}/${local_path}"

            if [ -f "$temp_file" ]; then
                mkdir -p "$(dirname "$local_file")"
                cp "$temp_file" "$local_file"
                echo -e "${GREEN}Synced $local_path${NC}"
            else
                echo -e "${RED}File not available${NC}"
            fi
            break
        fi
    done
}

show_commits() {
    echo -e "\n${BLUE}Recent commits to lumo:${NC}"
    curl -sL "${GITHUB_API}/commits?path=applications/lumo&per_page=10" | \
        grep -oP '("sha":\s*"[a-f0-9]+"|"message":\s*"[^"]+")' | \
        paste - - | while read -r line; do
            sha=$(echo "$line" | grep -oP '"sha":\s*"\K[a-f0-9]+' | head -c 8)
            msg=$(echo "$line" | grep -oP '"message":\s*"\K[^"]+' | head -c 60)
            echo -e "  ${YELLOW}${sha}${NC} ${msg}"
        done
}

test_build() {
    echo -e "\n${BLUE}Running build...${NC}"
    if npm run build; then
        echo -e "\n${GREEN}Build successful!${NC}"
    else
        echo -e "\n${RED}Build failed!${NC}"
    fi
}

# Main loop
while true; do
    show_menu
    read -p "Choice: " choice
    case $choice in
        1) show_diffs ;;
        2) sync_all_files ;;
        3) sync_specific_file ;;
        4) show_commits ;;
        5) test_build ;;
        6) show_patches ;;
        q|Q) echo "Bye!"; exit 0 ;;
        *) echo -e "${RED}Invalid choice${NC}" ;;
    esac
done
