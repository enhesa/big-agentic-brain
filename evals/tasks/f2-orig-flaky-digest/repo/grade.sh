#!/usr/bin/env bash
cd "$(dirname "$0")"
for s in 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do PYTHONHASHSEED=$s python3 -m unittest discover -s tests -t . -q 2>/dev/null || { echo "FAIL with PYTHONHASHSEED=$s"; exit 1; }; done; echo ALL_SEEDS_PASS
