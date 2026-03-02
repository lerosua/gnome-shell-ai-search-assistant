#!/bin/bash

# Configuration
UUID="ai-search-assistant@lerosua"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== AI Search Assistant Installer ===${NC}"

# 1. Parse Arguments (Dev Mode)
DEV_MODE=false
if [[ "$1" == "--dev" || "$1" == "-d" ]]; then
    DEV_MODE=true
    echo -e "${YELLOW}[Dev Mode] Using symbolic links...${NC}"
fi

# 2. Prepare Directory
echo "Installing to: $EXTENSION_DIR"
mkdir -p "$HOME/.local/share/gnome-shell/extensions"

if [ -d "$EXTENSION_DIR" ]; then
    echo "Removing existing installation..."
    rm -rf "$EXTENSION_DIR"
fi

# 3. Install Files
if [ "$DEV_MODE" = true ]; then
    ln -s "$SOURCE_DIR" "$EXTENSION_DIR"
    echo -e "${GREEN}✔ Symlink created.${NC}"
else
    mkdir -p "$EXTENSION_DIR"
    cp "$SOURCE_DIR"/*.js "$EXTENSION_DIR/"
    cp "$SOURCE_DIR"/*.css "$EXTENSION_DIR/"
    cp "$SOURCE_DIR"/metadata.json "$EXTENSION_DIR/"
    # Copy schemas/locale if they existed (future proofing)
    [ -d "$SOURCE_DIR/schemas" ] && cp -r "$SOURCE_DIR/schemas" "$EXTENSION_DIR/"
    [ -d "$SOURCE_DIR/locale" ] && cp -r "$SOURCE_DIR/locale" "$EXTENSION_DIR/"
    echo -e "${GREEN}✔ Files copied.${NC}"
fi

# 4. Compile settings schema (if present)
if [ -d "$EXTENSION_DIR/schemas" ]; then
    if command -v glib-compile-schemas &> /dev/null; then
        glib-compile-schemas "$EXTENSION_DIR/schemas"
        echo -e "${GREEN}✔ Schemas compiled.${NC}"
    else
        echo -e "${YELLOW}⚠ glib-compile-schemas not found; settings may not load.${NC}"
    fi
fi

# 5. Enable Extension
echo -e "\nEnabling extension..."
# Gnome extensions CLI might not pick it up immediately without a shell restart, but we try.
gnome-extensions enable "$UUID" 2>/dev/null

echo -e "\n${GREEN}=== Installation Complete ===${NC}"
echo "You may need to restart GNOME Shell for changes to take effect:"
echo "  - X11: Press Alt+F2, type 'r', Enter."
echo "  - Wayland: Log out and log back in."
echo ""
echo "Set API key with:"
echo "  gsettings set org.gnome.shell.extensions.ai-search-assistant api-key 'YOUR_API_KEY'"
echo "Set base URL with:"
echo "  gsettings set org.gnome.shell.extensions.ai-search-assistant base-url 'https://your-relay.example'"
echo ""
echo "Monitor logs with:"
echo "  journalctl -f -o cat /usr/bin/gnome-shell | grep \"AI Search Assistant\""
