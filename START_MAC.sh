#!/bin/bash
echo ""
echo "  ============================================"
echo "    MEETZ v2.0 — Starting Server"
echo "  ============================================"
echo ""
cd "$(dirname "$0")"
if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js not found. Install from https://nodejs.org"
  exit 1
fi
echo "  Installing packages (first time only)..."
npm install
echo ""
echo "  ============================================"
echo "    Meetz is LIVE!"
echo "    Open browser → http://localhost:3000"
echo "  ============================================"
echo ""
node server.js
