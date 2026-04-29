#!/bin/bash
# Start Cursor API Proxy (patched - no ask mode constraint)
# Cho phép Claude Code dùng Cursor Pro subscription

export CURSOR_BRIDGE_PORT=8318
export CURSOR_BRIDGE_API_KEY=my-local-secret
export CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false
export CURSOR_BRIDGE_WORKSPACE=/Users/khaihuynh
export CURSOR_BRIDGE_DIRECT=1

cd "$(dirname "$0")"
node dist/cli.js
