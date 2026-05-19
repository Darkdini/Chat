#!/bin/bash

echo ""
echo "  ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗"
echo "  ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝"
echo "  ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗"
echo "  ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║"
echo "  ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║"
echo "  ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝"
echo ""

# Check node
if ! command -v node &> /dev/null; then
  echo "❌ Node.js не найден."
  echo "   Установи: pkg install nodejs"
  exit 1
fi

# Install deps if needed
if [ ! -d "node_modules" ]; then
  echo "📦 Устанавливаю зависимости..."
  npm install
  if [ $? -ne 0 ]; then
    echo ""
    echo "❌ Ошибка npm install. Попробуй:"
    echo "   rm -rf node_modules package-lock.json"
    echo "   bash start.sh"
    exit 1
  fi
fi

# Get local IP for LAN access
IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}')

echo "✅ Зависимости готовы"
echo ""
echo "  🌐 Локально:  http://localhost:3000"
if [ -n "$IP" ]; then
  echo "  📱 По сети:   http://$IP:3000"
fi
echo ""
echo "  Ctrl+C — остановить сервер"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node server.js
