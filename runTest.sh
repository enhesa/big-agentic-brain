#!/usr/bin/env bash
set -ex
corepack enable || true
pnpm install --frozen-lockfile
pnpm check
