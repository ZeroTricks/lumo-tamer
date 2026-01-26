#!/bin/bash
#
# Sync upstream changes from Proton WebClients repository
# Usage: ./scripts/sync-upstream.sh
#
# Fetches files directly from GitHub without requiring a local clone.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

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

# File mappings: local_path -> upstream_path (relative to applications/lumo/src/app/)
declare -A UPSTREAM_FILES=(
    ["lib/lumo-api-client/core/encryption.ts"]="lib/lumo-api-client/core/encryption.ts"
    ["lib/lumo-api-client/core/streaming.ts"]="lib/lumo-api-client/core/streaming.ts"
    ["lib/lumo-api-client/core/types.ts"]="lib/lumo-api-client/core/types.ts"
    ["keys.ts"]="keys.ts"
    ["crypto/types.ts"]="crypto/types.ts"

    ["remote/api.ts"]="remote/api.ts"
    ["remote/types.ts"]="remote/types.ts"
    ["remote/conversion.ts"]="remote/conversion.ts"
    ["remote/scheduler.ts"]="remote/scheduler.ts"
    ["remote/util.ts"]="remote/util.ts"

    ["util/collections.ts"]="util/collections.ts"
    ["util/date.ts"]="util/date.ts"
    ["util/objects.ts"]="util/objects.ts"
    ["util/sorting.ts"]="util/sorting.ts"
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
for local_path in "${!UPSTREAM_FILES[@]}"; do
    upstream_path="${UPSTREAM_FILES[$local_path]}"
    temp_file="${TEMP_DIR}/${local_path}"
    mkdir -p "$(dirname "$temp_file")"

    if download_file "$upstream_path" "$temp_file"; then
        echo -e "  ${GREEN}✓${NC} $local_path"
    else
        echo -e "  ${RED}✗${NC} $local_path (download failed)"
    fi
done

# Check for changes
echo -e "\n${BLUE}Comparing with local files...${NC}"
declare -a CHANGED_FILES=()
declare -a MISSING_FILES=()

for local_path in "${!UPSTREAM_FILES[@]}"; do
    local_file="${UPSTREAM_DIR}/${local_path}"
    temp_file="${TEMP_DIR}/${local_path}"

    if [ ! -f "$temp_file" ]; then
        continue
    fi

    if [ -f "$local_file" ]; then
        if diff -q "$temp_file" "$local_file" >/dev/null 2>&1; then
            echo -e "  ${GREEN}=${NC} $local_path (up to date)"
        else
            echo -e "  ${YELLOW}~${NC} $local_path (changes available)"
            CHANGED_FILES+=("$local_path")
        fi
    else
        echo -e "  ${RED}!${NC} $local_path (missing locally)"
        MISSING_FILES+=("$local_path")
    fi
done

# Interactive menu
show_menu() {
    echo -e "\n${BLUE}=== Options ===${NC}"
    echo "  1) Show diff for changed files"
    echo "  2) Sync all upstream files"
    echo "  3) Sync specific file"
    echo "  4) Show recent upstream commits"
    echo "  5) Test build"
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
    for local_path in "${!UPSTREAM_FILES[@]}"; do
        local_file="${UPSTREAM_DIR}/${local_path}"
        temp_file="${TEMP_DIR}/${local_path}"

        if [ -f "$temp_file" ]; then
            mkdir -p "$(dirname "$local_file")"
            cp "$temp_file" "$local_file"
            echo -e "  ${GREEN}✓${NC} $local_path"
        fi
    done

    # Update UPSTREAM.md with new commit
    if [ -f "${UPSTREAM_DIR}/UPSTREAM.md" ]; then
        sed -i "s/\*\*Commit:\*\* [a-f0-9]*/\*\*Commit:\*\* ${LATEST_COMMIT}/" "${UPSTREAM_DIR}/UPSTREAM.md"
        sed -i "s/\*\*Sync Date:\*\* [0-9-]*/\*\*Sync Date:\*\* $(date +%Y-%m-%d)/" "${UPSTREAM_DIR}/UPSTREAM.md"
        echo -e "  ${GREEN}✓${NC} Updated UPSTREAM.md"
    fi

    echo -e "\n${GREEN}Sync complete!${NC}"
    echo -e "Run ${YELLOW}npm run build${NC} to verify."
}

sync_specific_file() {
    echo -e "\nSelect file to sync:"
    local all_files=("${!UPSTREAM_FILES[@]}")
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
        q|Q) echo "Bye!"; exit 0 ;;
        *) echo -e "${RED}Invalid choice${NC}" ;;
    esac
done
