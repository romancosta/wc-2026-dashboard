# FIFA World Cup 2026 Dashboard

A self-updating live dashboard for Raspberry Pi displaying fixtures, live scores, standings, and match events for the 2026 FIFA World Cup.

## Features
- Live scores, scorers, red cards, and match minute via ESPN
- Group standings with real-time updates during matches
- Rolling 10-match fixture window (past and upcoming)
- Qualification status indicators
- Match animations (goals, kickoff, halftime, fulltime, red cards)
- Goal scorer headshot overlays
- Auto-refreshes every 60 seconds (ESPN every 30s)
- Quiet hours: no API calls 2:20 AM to 11:40 AM ET
- Auto-shutdown at 2:30 AM ET every night

## Hardware Requirements
- Raspberry Pi 4B (4GB RAM recommended)
- Monitor (tested on 1080x1920 portrait orientation)
- MicroSD card (32GB recommended)

## Operating System
Raspberry Pi OS Desktop 64-bit — the full desktop version is required (not Lite) for Chromium kiosk autostart to work correctly.

## Display
The dashboard is designed for a vertically mounted display. The monitor is physically rotated to portrait orientation, and the OS display rotation is configured accordingly. Target resolution: 1080x1920 (landscape 1920x1080 monitor rotated 90 degrees).

## Data Sources
- **football-data.org** — fixtures and standings (free API key required)
- **ESPN public scoreboard API** — live scores, scorers, TV channels (unofficial, no key required)

> Note: The ESPN API is unofficial and undocumented. It may change without notice.

## Setup

### 1. Clone the repo


### 2. Get a free API key
Register at: https://www.football-data.org/client/register

### 3. Run the installer

This will: install Node.js if needed, install dependencies, prompt for your API key, configure the Node server as a system service, set up Chromium kiosk autostart, configure display rotation, and schedule auto-shutdown.

### 4. Reboot

The dashboard will launch automatically on boot.

### 5. Find your Pi IP (optional, for SSH)


## Notes
- .env is gitignored — never commit your API key
- The dashboard is designed for a vertically mounted 1080x1920 display
- The monitor is physically rotated 90 degrees to portrait orientation
- Auto-rotates display on boot via autostart configuration
- The Pi shuts down automatically at 2:30 AM ET every night — simply power it back on in the morning before games begin