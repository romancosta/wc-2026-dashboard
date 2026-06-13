#!/bin/bash
echo "=============================================="
echo "  FIFA World Cup 2026 Dashboard Setup"
echo "=============================================="
echo ""
echo "You need a free football-data.org API key."
echo "Get one at: https://www.football-data.org/client/register"
echo ""
read -p "Paste your API key here: " APIKEY
echo "FOOTBALL_DATA_API_KEY=$APIKEY" > .env
echo ""
echo "Installing dependencies..."
npm install
echo ""
echo "Done! Start the dashboard with: node server.js"
