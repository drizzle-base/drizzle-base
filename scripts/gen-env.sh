#!/bin/bash
# Writes .env with a random POSTGRES_PASSWORD, readable only by the owner. Never overwrites an existing one.
set -eu
cd "$(dirname "$0")/.."
if [ -f .env ]; then echo ".env exists; left untouched"; exit 0; fi
umask 077
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env
echo "wrote .env (mode 600)"
