#!/bin/zsh
# Double-click to start Squish and open it in your browser.
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
(sleep 1 && open http://localhost:4321) &
npm start
