#!/bin/bash
#
# Sync upstream changes from Proton WebClients repository
# Usage: ./scripts/sync-upstream.sh
#

set -e

# Configuration
UPSTREAM_REPO="ProtonMail/WebClients"
UPSTREAM_BRANCH="main"
UPSTREAM_BASE="https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_BRANCH}"
TEMP_DIR=$(mktemp -d)
LOCAL_PROTON_DIR="src/proton"
UPSTREAM_MD="${LOCAL_PROTON_DIR}/UPSTREAM.md"
CONFIG_FILE="config.yaml"

# Diff tool (override with DIFF_TOOL env var)
DIFF_TOOL="${DIFF_TOOL:-diff}"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Upstream file mappings: local_file:upstream_path
declare -A FILE_MAP=(
    ["types.ts"]="applications/lumo/src/app/lib/lumo-api-client/core/types.ts"
    ["streaming.ts"]="applications/lumo/src/app/lib/lumo-api-client/core/streaming.ts"
    ["keys.ts"]="applications/lumo/src/app/keys.ts"
    ["encryption.ts"]="applications/lumo/src/app/lib/lumo-api-client/core/encryption.ts"
)

# Additional files to check (not adapted but useful for reference)
declare -A REFERENCE_FILES=(
    ["crypto-reference"]="applications/lumo/src/app/crypto/index.ts"
    ["aes-gcm-reference"]="packages/crypto/lib/subtle/aesGcm.ts"
    ["package.json"]="applications/lumo/package.json"
)

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo -e "${BLUE}=== Proton WebClients Upstream Sync ===${NC}\n"

# Get current tracked commit from UPSTREAM.md
CURRENT_COMMIT=$(grep -oP '(?<=\*\*Commit:\*\* )[a-f0-9]+' "$UPSTREAM_MD" 2>/dev/null || echo "unknown")
echo -e "Currently tracking commit: ${YELLOW}${CURRENT_COMMIT:0:12}${NC}"

# Fetch latest commit info
echo -e "\nFetching latest upstream info..."
LATEST_COMMIT=$(curl -sL "https://api.github.com/repos/${UPSTREAM_REPO}/commits/${UPSTREAM_BRANCH}" | grep -oP '(?<="sha": ")[a-f0-9]+' | head -1)

if [ -z "$LATEST_COMMIT" ]; then
    echo -e "${RED}Failed to fetch latest commit info${NC}"
    exit 1
fi

echo -e "Latest upstream commit: ${GREEN}${LATEST_COMMIT:0:12}${NC}"

if [ "$CURRENT_COMMIT" = "$LATEST_COMMIT" ]; then
    echo -e "\n${GREEN}Already up to date!${NC}"
else
    echo -e "\n${YELLOW}Upstream has new commits${NC}"
    # Show commits between current and latest
    echo -e "\nRecent commits:"
    curl -sL "https://api.github.com/repos/${UPSTREAM_REPO}/commits?sha=${UPSTREAM_BRANCH}&per_page=5" | \
        grep -oP '(?<="message": ")[^"]+' | head -5 | while read -r msg; do
            echo "  • ${msg:0:70}"
        done
fi

# Download upstream files
echo -e "\n${BLUE}Downloading upstream files...${NC}"
mkdir -p "$TEMP_DIR/upstream"

download_file() {
    local name="$1"
    local path="$2"
    local url="${UPSTREAM_BASE}/${path}"
    local output="$TEMP_DIR/upstream/$name"

    if curl -sL -o "$output" "$url"; then
        if [ -s "$output" ] && ! grep -q "404: Not Found" "$output" 2>/dev/null; then
            echo -e "  ${GREEN}✓${NC} $name"
            return 0
        fi
    fi
    echo -e "  ${RED}✗${NC} $name (failed to download)"
    return 1
}

for name in "${!FILE_MAP[@]}"; do
    download_file "$name" "${FILE_MAP[$name]}"
done

for name in "${!REFERENCE_FILES[@]}"; do
    download_file "$name" "${REFERENCE_FILES[$name]}"
done

# Check for appVersion in upstream package.json
echo -e "\n${BLUE}Checking appVersion...${NC}"
if [ -f "$TEMP_DIR/upstream/package.json" ]; then
    UPSTREAM_VERSION=$(grep -oP '(?<="version": ")[^"]+' "$TEMP_DIR/upstream/package.json" | head -1)
    if [ -n "$UPSTREAM_VERSION" ]; then
        UPSTREAM_APP_VERSION="web-lumo@${UPSTREAM_VERSION}"
        echo -e "  Upstream version: ${GREEN}${UPSTREAM_APP_VERSION}${NC}"

        # Get current version from config
        if [ -f "$CONFIG_FILE" ]; then
            CURRENT_APP_VERSION=$(grep -oP '(?<=appVersion: ")[^"]+' "$CONFIG_FILE" | head -1)
            echo -e "  Current config:   ${YELLOW}${CURRENT_APP_VERSION:-not set}${NC}"

            if [ "$UPSTREAM_APP_VERSION" != "$CURRENT_APP_VERSION" ]; then
                echo -e "  ${YELLOW}Version mismatch detected${NC}"
            fi
        fi
    fi
fi

# Analyze changes
echo -e "\n${BLUE}Analyzing changes...${NC}"
declare -A CHANGED_FILES
HAS_CHANGES=false

for name in "${!FILE_MAP[@]}"; do
    local_file="${LOCAL_PROTON_DIR}/${name}"
    upstream_file="$TEMP_DIR/upstream/$name"

    if [ ! -f "$upstream_file" ]; then
        continue
    fi

    if [ -f "$local_file" ]; then
        # Compare (ignoring import differences since we adapted those)
        if ! diff -q "$upstream_file" "$local_file" >/dev/null 2>&1; then
            CHANGED_FILES["$name"]="$upstream_file"
            HAS_CHANGES=true
            lines_changed=$(diff "$upstream_file" "$local_file" 2>/dev/null | grep -c '^[<>]' || echo "?")
            echo -e "  ${YELLOW}~${NC} $name (${lines_changed} lines differ)"
        else
            echo -e "  ${GREEN}=${NC} $name (unchanged)"
        fi
    else
        echo -e "  ${RED}?${NC} $name (local file not found)"
    fi
done

# Menu
show_menu() {
    echo -e "\n${BLUE}=== Options ===${NC}"
    echo "  1) View summary of changes"
    echo "  2) Open file in diff tool ($DIFF_TOOL)"
    echo "  3) Update appVersion in config.yaml"
    echo "  4) Update UPSTREAM.md with latest commit"
    echo "  5) Copy upstream file to temp for manual review"
    echo "  6) Show upstream commit history"
    echo "  q) Quit"
    echo ""
}

view_summary() {
    echo -e "\n${BLUE}Change Summary:${NC}"
    for name in "${!CHANGED_FILES[@]}"; do
        echo -e "\n${YELLOW}--- $name ---${NC}"
        local_file="${LOCAL_PROTON_DIR}/${name}"
        upstream_file="${CHANGED_FILES[$name]}"
        # Show compact diff stats
        diff "$upstream_file" "$local_file" 2>/dev/null | head -20
        total=$(diff "$upstream_file" "$local_file" 2>/dev/null | wc -l)
        if [ "$total" -gt 20 ]; then
            echo "... ($total total diff lines, showing first 20)"
        fi
    done
}

open_diff_tool() {
    if [ ${#CHANGED_FILES[@]} -eq 0 ]; then
        echo -e "${YELLOW}No changed files to compare${NC}"
        return
    fi

    echo -e "\nSelect file to compare:"
    select name in "${!CHANGED_FILES[@]}" "Cancel"; do
        if [ "$name" = "Cancel" ]; then
            break
        elif [ -n "$name" ]; then
            local_file="${LOCAL_PROTON_DIR}/${name}"
            upstream_file="${CHANGED_FILES[$name]}"
            echo -e "Opening: $DIFF_TOOL \"$upstream_file\" \"$local_file\""
            $DIFF_TOOL "$upstream_file" "$local_file" 2>/dev/null || {
                echo -e "${RED}Failed to open diff tool. Set DIFF_TOOL env var.${NC}"
                echo "Example: DIFF_TOOL=meld ./scripts/sync-upstream.sh"
            }
            break
        fi
    done
}

update_app_version() {
    if [ -z "$UPSTREAM_APP_VERSION" ]; then
        echo -e "${RED}Could not determine upstream version${NC}"
        return
    fi

    if [ ! -f "$CONFIG_FILE" ]; then
        echo -e "${RED}Config file not found: $CONFIG_FILE${NC}"
        return
    fi

    echo -e "Updating appVersion to: ${GREEN}${UPSTREAM_APP_VERSION}${NC}"
    sed -i "s/appVersion: \"[^\"]*\"/appVersion: \"${UPSTREAM_APP_VERSION}\"/" "$CONFIG_FILE"
    echo -e "${GREEN}Updated!${NC}"

    # Also update example config
    if [ -f "config.example.yaml" ]; then
        sed -i "s/appVersion: \"[^\"]*\"/appVersion: \"${UPSTREAM_APP_VERSION}\"/" "config.example.yaml"
        echo -e "${GREEN}Also updated config.example.yaml${NC}"
    fi
}

update_upstream_md() {
    if [ -z "$LATEST_COMMIT" ]; then
        echo -e "${RED}Could not determine latest commit${NC}"
        return
    fi

    echo -e "Updating UPSTREAM.md commit to: ${GREEN}${LATEST_COMMIT:0:12}${NC}"
    sed -i "s/\*\*Commit:\*\* [a-f0-9]*/\*\*Commit:\*\* ${LATEST_COMMIT}/" "$UPSTREAM_MD"

    # Update date
    TODAY=$(date +%Y-%m-%d)
    sed -i "s/\*\*Extraction Date:\*\* [0-9-]*/\*\*Extraction Date:\*\* ${TODAY}/" "$UPSTREAM_MD"

    echo -e "${GREEN}Updated!${NC}"
}

copy_for_review() {
    echo -e "\nSelect file to copy:"
    local all_files=("${!FILE_MAP[@]}" "${!REFERENCE_FILES[@]}")
    select name in "${all_files[@]}" "Cancel"; do
        if [ "$name" = "Cancel" ]; then
            break
        elif [ -n "$name" ]; then
            upstream_file="$TEMP_DIR/upstream/$name"
            if [ -f "$upstream_file" ]; then
                dest="$TEMP_DIR/${name}.upstream"
                cp "$upstream_file" "$dest"
                echo -e "Copied to: ${GREEN}${dest}${NC}"
                echo "(File will be deleted when script exits)"
            else
                echo -e "${RED}File not found${NC}"
            fi
            break
        fi
    done
}

show_commit_history() {
    echo -e "\n${BLUE}Recent commits to lumo directory:${NC}"
    curl -sL "https://api.github.com/repos/${UPSTREAM_REPO}/commits?sha=${UPSTREAM_BRANCH}&path=applications/lumo&per_page=10" | \
        grep -oP '("sha": "[a-f0-9]+"|"message": "[^"]+"|"date": "[^"]+")' | \
        paste - - - | while read -r line; do
            sha=$(echo "$line" | grep -oP '(?<="sha": ")[a-f0-9]+' | head -c 8)
            msg=$(echo "$line" | grep -oP '(?<="message": ")[^"]+' | head -c 60)
            date=$(echo "$line" | grep -oP '(?<="date": ")[^"]+' | head -c 10)
            echo -e "  ${YELLOW}${sha}${NC} ${date} ${msg}"
        done
}

# Main loop
while true; do
    show_menu
    read -p "Choice: " choice
    case $choice in
        1) view_summary ;;
        2) open_diff_tool ;;
        3) update_app_version ;;
        4) update_upstream_md ;;
        5) copy_for_review ;;
        6) show_commit_history ;;
        q|Q) echo "Bye!"; exit 0 ;;
        *) echo -e "${RED}Invalid choice${NC}" ;;
    esac
done
