#!/usr/bin/env bash
set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${BOLD}${CYAN}"
echo "   ██████╗ ██████╗  ██████╗ ███████╗███╗   ██╗████████╗"
echo "  ██╔════╝██╔═══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝"
echo "  ██║     ██║   ██║██║  ███╗█████╗  ██╔██╗ ██║   ██║"
echo "  ██║     ██║   ██║██║   ██║██╔══╝  ██║╚██╗██║   ██║"
echo "  ╚██████╗╚██████╔╝╚██████╔╝███████╗██║ ╚████║   ██║"
echo "   ╚═════╝ ╚═════╝  ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝"
echo -e "${NC}"
echo "  Quick installer — runs the interactive setup"
echo ""

# Check Node.js exists
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}Node.js is not installed.${NC}"
    echo "Install Node.js 18+ first:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs"
    echo ""
    echo "Or use nvm:"
    echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash"
    echo "  nvm install 22"
    exit 1
fi

NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d v)
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo -e "${YELLOW}Node.js $(node -v) detected. Version 18+ required.${NC}"
    exit 1
fi

echo -e "${GREEN}Node.js $(node -v) detected${NC}"

# Install deps if needed
if [ ! -d "node_modules" ]; then
    echo ""
    echo "Installing dependencies..."
    npm install
fi

# Run interactive setup
echo ""
exec node setup.js
