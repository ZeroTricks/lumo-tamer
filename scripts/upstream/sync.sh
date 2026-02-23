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
PROTON_SHIMS_DIR="src/proton-shims"
SCRIPTS_DIR="scripts/upstream"
UPSTREAM_BASE_URL="https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_BRANCH}/applications/lumo/src/app"
PACKAGES_BASE_URL="https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_BRANCH}/packages"
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
    lib/lumo-api-client/core/encryptionParams.ts
    lib/lumo-api-client/core/streaming.ts
    lib/lumo-api-client/core/types.ts
    lib/lumo-api-client/utils.ts
    keys.ts
    crypto/index.ts
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
)

# Shim files: local implementations, check upstream changes between syncs
SHIM_SOURCE_FILES=(
    config.ts
    lib/lumo-api-client/index.ts
    crypto/index.ts
    redux/slices/index.ts
    redux/slices/lumoUserSettings.ts
    redux/slices/attachmentLoadingState.ts
    redux/store.ts
    redux/rootReducer.ts
    util/safeLogger.ts
    services/search/searchService.ts
)

# Adapted files: partial reuse with different structure
ADAPTED_SOURCE_FILES=(
    mocks/handlers.ts
)

# Proton-shims: files synced from packages/ (mirroring packages/ structure)
# These files work unchanged with our polyfills and tsconfig aliases
PROTON_SHIMS_UPSTREAM_FILES=(
    crypto/lib/subtle/aesGcm.ts
    crypto/lib/subtle/hash.ts
    utils/mergeUint8Arrays.ts
)

# Proton-shims source files: local implementations, track upstream changes
# These are partial reimplementations - we don't sync them but warn on changes
PROTON_SHIMS_SHIM_SOURCE_FILES=(
    crypto/lib/proxy/proxy.ts
    crypto/lib/utils.ts
    shared/lib/apps/helper.ts
    shared/lib/fetch/headers.ts
)

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

# Download a file from upstream (applications/lumo/src/app/)
download_file() {
    local upstream_path="$1"
    local output_file="$2"
    local url="${UPSTREAM_BASE_URL}/${upstream_path}"

    # curl -f fails on HTTP errors (404 etc), -s is silent, -L follows redirects
    curl -sfL -o "$output_file" "$url"
}

# Download a file from packages/
download_packages_file() {
    local packages_path="$1"
    local output_file="$2"
    local url="${PACKAGES_BASE_URL}/${packages_path}"

    curl -sfL -o "$output_file" "$url"
}

# Download and compare upstream files
echo -e "\n${BLUE}Checking upstream files...${NC}"
declare -a CHANGED_FILES=()
declare -a FAILED_FILES=()

for file_path in "${UPSTREAM_FILES[@]}"; do
    local_file="${UPSTREAM_DIR}/${file_path}"
    temp_file="${TEMP_DIR}/${file_path}"
    mkdir -p "$(dirname "$temp_file")"

    if ! download_file "$file_path" "$temp_file"; then
        echo -e "  ${RED}✗${NC} $file_path (download failed)"
        FAILED_FILES+=("$file_path")
        continue
    fi

    if [ -f "$local_file" ]; then
        if ! diff -q "$temp_file" "$local_file" >/dev/null 2>&1; then
            echo -e "  ${YELLOW}~${NC} $file_path"
            CHANGED_FILES+=("$file_path")
        fi
    else
        echo -e "  ${RED}+${NC} $file_path (missing locally)"
        CHANGED_FILES+=("$file_path")
    fi
done

if [ ${#CHANGED_FILES[@]} -eq 0 ] && [ ${#FAILED_FILES[@]} -eq 0 ]; then
    echo -e "  ${GREEN}All ${#UPSTREAM_FILES[@]} files up to date${NC}"
fi

# Download and compare proton-shims files (from packages/)
echo -e "\n${BLUE}Checking proton-shims files (packages/)...${NC}"
declare -a CHANGED_SHIMS_FILES=()
declare -a FAILED_SHIMS_FILES=()

for file_path in "${PROTON_SHIMS_UPSTREAM_FILES[@]}"; do
    local_file="${PROTON_SHIMS_DIR}/${file_path}"
    temp_file="${TEMP_DIR}/packages_${file_path}"
    mkdir -p "$(dirname "$temp_file")"

    if ! download_packages_file "$file_path" "$temp_file"; then
        echo -e "  ${RED}✗${NC} $file_path (download failed)"
        FAILED_SHIMS_FILES+=("$file_path")
        continue
    fi

    if [ -f "$local_file" ]; then
        if ! diff -q "$temp_file" "$local_file" >/dev/null 2>&1; then
            echo -e "  ${YELLOW}~${NC} $file_path"
            CHANGED_SHIMS_FILES+=("$file_path")
        fi
    else
        echo -e "  ${RED}+${NC} $file_path (missing locally)"
        CHANGED_SHIMS_FILES+=("$file_path")
    fi
done

if [ ${#CHANGED_SHIMS_FILES[@]} -eq 0 ] && [ ${#FAILED_SHIMS_FILES[@]} -eq 0 ]; then
    echo -e "  ${GREEN}All ${#PROTON_SHIMS_UPSTREAM_FILES[@]} files up to date${NC}"
fi

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

# Get previous commit for diffing shim/adapted sources
PREV_COMMIT=""
COMMIT_FILE="${SCRIPTS_DIR}/last-sync-commit"
if [ -f "$COMMIT_FILE" ]; then
    PREV_COMMIT=$(cat "$COMMIT_FILE" 2>/dev/null | tr -d '[:space:]')
fi

# Build URL for a specific commit (applications/lumo/src/app/)
commit_url() {
    local commit="$1"
    local path="$2"
    echo "https://raw.githubusercontent.com/${UPSTREAM_REPO}/${commit}/applications/lumo/src/app/${path}"
}

# Build URL for a specific commit (packages/)
packages_commit_url() {
    local commit="$1"
    local path="$2"
    echo "https://raw.githubusercontent.com/${UPSTREAM_REPO}/${commit}/packages/${path}"
}

# Build GitHub compare URL for a specific file
github_file_diff_url() {
    local file_path="$1"
    echo "https://github.com/${UPSTREAM_REPO}/compare/${PREV_COMMIT:0:12}..${LATEST_COMMIT:0:12}#diff-$(echo -n "applications/lumo/src/app/${file_path}" | sha256sum | cut -d' ' -f1)"
}

# Check shim/adapted source files for upstream changes by diffing between commits
# These are files we've replaced with local implementations - warn if upstream changes
check_source_changes() {
    local label="$1"
    shift
    local files=("$@")

    echo -e "\n${BLUE}Checking ${label} sources...${NC}"

    if [ -z "$PREV_COMMIT" ]; then
        echo -e "  ${YELLOW}!${NC} No previous commit in ${COMMIT_FILE}"
        return
    fi

    if [ "$PREV_COMMIT" = "$LATEST_COMMIT" ]; then
        echo -e "  ${GREEN}=${NC} Same commit as last sync"
        return
    fi

    for file_path in "${files[@]}"; do
        local old_file="${TEMP_DIR}/_old_${file_path//\//_}"
        local new_file="${TEMP_DIR}/_new_${file_path//\//_}"

        # Download from previous and current commits
        local got_old=false got_new=false
        if curl -sfL -o "$old_file" "$(commit_url "$PREV_COMMIT" "$file_path")" 2>/dev/null; then
            got_old=true
        fi
        if curl -sfL -o "$new_file" "$(commit_url "$LATEST_COMMIT" "$file_path")" 2>/dev/null; then
            got_new=true
        fi

        if $got_old && $got_new; then
            if ! diff -q "$old_file" "$new_file" >/dev/null 2>&1; then
                local lines
                lines=$(diff "$old_file" "$new_file" 2>/dev/null | wc -l)
                echo -e "  ${YELLOW}⚠${NC} $file_path (~${lines} lines)"
                echo -e "    $(github_file_diff_url "$file_path")"
                CHANGED_SOURCE_FILES+=("$file_path")
            fi
        elif $got_new && ! $got_old; then
            echo -e "  ${YELLOW}+${NC} $file_path (new upstream)"
            echo -e "    $(github_file_diff_url "$file_path")"
            CHANGED_SOURCE_FILES+=("$file_path")
        elif $got_old && ! $got_new; then
            echo -e "  ${RED}-${NC} $file_path (removed upstream)"
        else
            echo -e "  ${RED}✗${NC} $file_path (download failed)"
        fi
    done

    if [ ${#CHANGED_SOURCE_FILES[@]} -eq 0 ]; then
        echo -e "  ${GREEN}No changes${NC}"
    fi
}

declare -a CHANGED_SOURCE_FILES=()
check_source_changes "shim" "${SHIM_SOURCE_FILES[@]}"
check_source_changes "adapted" "${ADAPTED_SOURCE_FILES[@]}"

# Check proton-shims source files for upstream changes (from packages/)
check_proton_shims_source_changes() {
    echo -e "\n${BLUE}Checking proton-shims shim sources (packages/)...${NC}"

    if [ -z "$PREV_COMMIT" ]; then
        echo -e "  ${YELLOW}!${NC} No previous commit in ${COMMIT_FILE}"
        return
    fi

    if [ "$PREV_COMMIT" = "$LATEST_COMMIT" ]; then
        echo -e "  ${GREEN}=${NC} Same commit as last sync"
        return
    fi

    local changes=0
    for file_path in "${PROTON_SHIMS_SHIM_SOURCE_FILES[@]}"; do
        local old_file="${TEMP_DIR}/_old_pkg_${file_path//\//_}"
        local new_file="${TEMP_DIR}/_new_pkg_${file_path//\//_}"

        local got_old=false got_new=false
        if curl -sfL -o "$old_file" "$(packages_commit_url "$PREV_COMMIT" "$file_path")" 2>/dev/null; then
            got_old=true
        fi
        if curl -sfL -o "$new_file" "$(packages_commit_url "$LATEST_COMMIT" "$file_path")" 2>/dev/null; then
            got_new=true
        fi

        if $got_old && $got_new; then
            if ! diff -q "$old_file" "$new_file" >/dev/null 2>&1; then
                local lines
                lines=$(diff "$old_file" "$new_file" 2>/dev/null | wc -l)
                echo -e "  ${YELLOW}⚠${NC} packages/$file_path (~${lines} lines)"
                echo -e "    https://github.com/${UPSTREAM_REPO}/compare/${PREV_COMMIT:0:12}..${LATEST_COMMIT:0:12}#diff-$(echo -n "packages/${file_path}" | sha256sum | cut -d' ' -f1)"
                changes=$((changes + 1))
            fi
        elif $got_new && ! $got_old; then
            echo -e "  ${YELLOW}+${NC} packages/$file_path (new upstream)"
            changes=$((changes + 1))
        elif $got_old && ! $got_new; then
            echo -e "  ${RED}-${NC} packages/$file_path (removed upstream)"
        else
            echo -e "  ${RED}✗${NC} packages/$file_path (download failed)"
        fi
    done

    if [ $changes -eq 0 ]; then
        echo -e "  ${GREEN}No changes${NC}"
    fi
}

check_proton_shims_source_changes

# Parse series file and call handler for each patch
# Usage: for_each_patch handler_func
# Handler receives: patch_name patch_file
for_each_patch() {
    local handler="$1"
    local patches_dir="${SCRIPTS_DIR}/patches"
    local series_file="${patches_dir}/series"

    while IFS= read -r line || [ -n "$line" ]; do
        [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
        local patch_name
        patch_name=$(echo "$line" | sed 's/#.*$//' | xargs)
        [[ -z "$patch_name" ]] && continue
        "$handler" "$patch_name" "${patches_dir}/${patch_name}"
    done < "$series_file"
}

# Apply patches from patches/series
# Uses --merge to produce git-style conflict markers on failure
apply_patches() {
    local patches_dir="${SCRIPTS_DIR}/patches"
    local series_file="${patches_dir}/series"

    if [ ! -f "$series_file" ]; then
        echo -e "  ${YELLOW}!${NC} No patches/series file found"
        return 0
    fi

    echo -e "\n${BLUE}Applying patches...${NC}"
    local applied=0
    local conflicts=0

    apply_single_patch() {
        local patch_name="$1"
        local patch_file="$2"

        if [ ! -f "$patch_file" ]; then
            echo -e "  ${RED}!${NC} $patch_name (file not found)"
            conflicts=$((conflicts + 1))
            return
        fi

        # Check if already applied
        if patch -d "$UPSTREAM_DIR" -p1 --forward -s --dry-run < "$patch_file" 2>/dev/null; then
            # Try to apply (might already be applied)
            if patch -d "$UPSTREAM_DIR" -p1 --forward -s < "$patch_file" 2>/dev/null; then
                echo -e "  ${GREEN}+${NC} $patch_name"
                applied=$((applied + 1))
            else
                echo -e "  ${GREEN}=${NC} $patch_name (already applied)"
            fi
        else
            # Patch conflicts - apply with --merge for conflict markers
            echo -e "  ${RED}!${NC} $patch_name (conflict)"
            patch -d "$UPSTREAM_DIR" -p1 --forward --merge < "$patch_file" 2>/dev/null || true
            conflicts=$((conflicts + 1))
        fi
    }

    for_each_patch apply_single_patch

    if [ $conflicts -gt 0 ]; then
        echo -e "\n${YELLOW}$conflicts patch(es) have conflicts - resolve in editor${NC}"
    fi
}


sync_files() {
    echo -e "\n${BLUE}Syncing ${#UPSTREAM_FILES[@]} upstream files...${NC}"
    for file_path in "${UPSTREAM_FILES[@]}"; do
        local local_file="${UPSTREAM_DIR}/${file_path}"
        local temp_file="${TEMP_DIR}/${file_path}"

        if [ -f "$temp_file" ]; then
            mkdir -p "$(dirname "$local_file")"
            cp "$temp_file" "$local_file"
        fi
    done

    # Sync proton-shims files from packages/
    echo -e "\n${BLUE}Syncing ${#PROTON_SHIMS_UPSTREAM_FILES[@]} proton-shims files...${NC}"
    for file_path in "${PROTON_SHIMS_UPSTREAM_FILES[@]}"; do
        local local_file="${PROTON_SHIMS_DIR}/${file_path}"
        local temp_file="${TEMP_DIR}/packages_${file_path}"

        if [ -f "$temp_file" ]; then
            mkdir -p "$(dirname "$local_file")"
            cp "$temp_file" "$local_file"
        fi
    done

    # Update commit tracking
    echo "$LATEST_COMMIT" > "$COMMIT_FILE"
    echo -e "  Updated .last-sync-commit (${LATEST_COMMIT:0:12})"

    # Also update docs/upstream.md for human reference
    if [ -f "docs/upstream.md" ]; then
        sed -i "s/\*\*Commit:\*\* [a-f0-9]*/\*\*Commit:\*\* ${LATEST_COMMIT}/" "docs/upstream.md"
        sed -i "s/\*\*Sync Date:\*\* [0-9-]*/\*\*Sync Date:\*\* $(date +%Y-%m-%d)/" "docs/upstream.md"
    fi

    # Apply patches after syncing pristine files
    apply_patches
}

# Summary and prompt
echo ""
total_changes=$((${#CHANGED_FILES[@]} + ${#FAILED_FILES[@]} + ${#CHANGED_SOURCE_FILES[@]} + ${#CHANGED_SHIMS_FILES[@]} + ${#FAILED_SHIMS_FILES[@]}))

if [ $total_changes -eq 0 ]; then
    echo -e "${GREEN}Everything up to date.${NC}"
    exit 0
fi

echo -e "${YELLOW}Summary:${NC}"
[ ${#CHANGED_FILES[@]} -gt 0 ] && echo -e "  ${#CHANGED_FILES[@]} upstream file(s) changed"
[ ${#CHANGED_SHIMS_FILES[@]} -gt 0 ] && echo -e "  ${#CHANGED_SHIMS_FILES[@]} proton-shims file(s) changed"
[ ${#FAILED_FILES[@]} -gt 0 ] && echo -e "  ${#FAILED_FILES[@]} download failure(s)"
[ ${#FAILED_SHIMS_FILES[@]} -gt 0 ] && echo -e "  ${#FAILED_SHIMS_FILES[@]} proton-shims download failure(s)"
[ ${#CHANGED_SOURCE_FILES[@]} -gt 0 ] && echo -e "  ${#CHANGED_SOURCE_FILES[@]} shim/adapted source(s) changed"

if [ ${#FAILED_FILES[@]} -gt 0 ] || [ ${#FAILED_SHIMS_FILES[@]} -gt 0 ]; then
    echo -e "\n${RED}Cannot sync: file(s) failed to download.${NC}"
    echo "Fix the issue (check network, remove stale entries) and retry."
    exit 1
fi

echo ""
read -rp "Sync now? [y/N] " answer
if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
fi

sync_files

echo -e "\n${GREEN}Sync complete.${NC} Review changes with git diff, then run ${YELLOW}npm run build${NC}."
