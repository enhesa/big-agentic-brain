#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
# CI runs in two regions
TZ=America/Los_Angeles node --test test/*.test.js
TZ=Pacific/Auckland node --test test/*.test.js
