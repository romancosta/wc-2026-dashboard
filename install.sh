#!/bin/bash
set -e

echo "=============================================="
echo "  FIFA World Cup 2026 Dashboard Installer"
echo "=============================================="
echo ""

# 1. Install Node.js if missing
if ! command -v node &> /dev/null; then
  echo "Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
else
  echo "Node.js already installed: $(node -v)"
fi

# 2. Install npm dependencies
echo ""
echo "Installing npm dependencies..."
npm install

# 3. Install system packages
echo ""
echo "Installing system packages..."
sudo apt install -y wtype chromium

# 4. API key
echo ""
echo "You need a free football-data.org API key."
echo "Register at: https://www.football-data.org/client/register"
echo ""
read -p "Paste your API key here: " APIKEY
echo "FOOTBALL_DATA_API_KEY=$APIKEY" > .env
echo "API key saved to .env"

# 5. Systemd service
echo ""
echo "Setting up Node server as a system service..."
DASHBOARD_DIR=$(pwd)
DASHBOARD_USER=$(whoami)
sudo bash -c "cat > /etc/systemd/system/dashboard.service << SERVICE
[Unit]
Description=WC Dashboard Node Server
After=network.target

[Service]
Type=simple
User=$DASHBOARD_USER
WorkingDirectory=$DASHBOARD_DIR
ExecStart=/usr/bin/node $DASHBOARD_DIR/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE"
sudo systemctl daemon-reload
sudo systemctl enable dashboard
sudo systemctl start dashboard
echo "Dashboard service enabled and started"

# 6. Display rotation autostart
echo ""
echo "Configuring autostart..."
mkdir -p ~/.config/autostart

cat > ~/.config/autostart/rotate.desktop << ROTATE
[Desktop Entry]
Type=Application
Name=Rotate Display
Exec=bash -c 'sleep 3 && WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/$(id -u) wlr-randr --output HDMI-A-2 --transform 90'
X-GNOME-Autostart-enabled=true
ROTATE

# 7. Chromium kiosk autostart
cat > ~/.config/autostart/kiosk.desktop << KIOSK
[Desktop Entry]
Type=Application
Name=Kiosk
Exec=bash -c 'sleep 10 && chromium --noerrdialogs --disable-infobars --kiosk http://localhost:3000'
X-GNOME-Autostart-enabled=true
KIOSK

# 8. Hide cursor autostart
cat > ~/.config/autostart/hidecursor.desktop << CURSOR
[Desktop Entry]
Type=Application
Name=Hide Cursor
Exec=bash -c 'sleep 5 && WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/$(id -u) gsettings set org.gnome.desktop.interface cursor-size 1'
X-GNOME-Autostart-enabled=true
CURSOR

echo "Autostart files created"

# 9. Auto-shutdown cron at 2:30 AM
echo ""
echo "Setting up 2:30 AM auto-shutdown..."
(sudo crontab -l 2>/dev/null | grep -v shutdown; echo "30 2 * * * /sbin/shutdown -h now") | sudo crontab -
echo "Auto-shutdown scheduled"

# 10. Passwordless sudo
echo ""
echo "Configuring passwordless sudo..."
echo "$(whoami) ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/dashboard-user > /dev/null

echo ""
echo "=============================================="
echo "  Installation complete!"
echo "  Reboot to start the dashboard:"
echo "  sudo reboot"
echo "=============================================="