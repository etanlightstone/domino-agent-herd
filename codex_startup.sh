#!/bin/bash
if [ -n "$CODEX_AUTH_JSON_B64" ]; then
  mkdir -p /home/ubuntu/.codex
  if [ ! -s /home/ubuntu/.codex/auth.json ]; then
    printf '%s' "$CODEX_AUTH_JSON_B64" | base64 -d > /home/ubuntu/.codex/auth.json
  fi
  chown -R ubuntu:ubuntu /home/ubuntu/.codex
  chmod 700 /home/ubuntu/.codex
  chmod 600 /home/ubuntu/.codex/auth.json
fi
