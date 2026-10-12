#!/usr/bin/env bash
# Seeds a LOCAL brain with realistic demo content so the UI can be designed against
# real rows. Idempotent (every POST carries an Idempotency-Key). Never run against
# bab.example.com: it writes as made-up colleagues.
set -euo pipefail
O="${BAB_ORIGIN:-http://localhost:4310}"
case "$O" in *example.com*) echo "refusing to seed a non-local origin: $O" >&2; exit 1;; esac

post() { # actor-email actor-name path idem-key json
  curl -s -o /dev/null -w "%{http_code} $3\n" -X POST "$O$3" \
    -H "X-Bab-Actor-Email: $1" -H "X-Bab-Actor-Name: $2" \
    -H "Content-Type: application/json" -H "Idempotency-Key: seed-$4" -d "$5"
}
learn() { # email name key title body tags [extra-json]
  post "$1" "$2" /api/learnings "$3" "{\"title\":\"$4\",\"body\":\"$5\",\"tags\":[$6]${7:-}}"
}

MAYA="maya.kowalski@example.com"; MAYAN="Maya Kowalski"
ELI="eli.brandt@example.com";     ELIN="Eli Brandt"
SVEN="sven.aalto@example.com";    SVENN="Sven Aalto"
LEA="lea.moreau@example.com";     LEAN="Lea Moreau"
PRIYA="priya.nair@example.com";   PRIYAN="Priya Nair"

learn $MAYA "$MAYAN" l1 "UTM naming for campaigns: utm_campaign = q4-{region}-{product}" "Every paid and owned link uses utm_campaign=<quarter>-<region>-<product>, lowercase, hyphens only. Region codes: eu, us, apac. Product codes: esg, ehs, cmd. Example: q4-eu-esg. Anything else breaks the attribution dashboard." '"marketing","campaigns"' ',"confidence":"high"'
learn $MAYA "$MAYAN" l2 "Brand toolkit 2026 lives in the Marketing SharePoint under Brand/2026" "Fonts: Urbanist for headings, Inter for body, Inconsolata for code. Primary teal #00B0A1, navy #1A3360. Never use the 2023 palette (the coral was retired)." '"marketing","brand"'
learn $SVEN "$SVENN" l3 "Pricing quotes need legal review before they leave the building" "Any quote with non-standard terms (multi-year, custom SLA, data residency) goes to Legal first. Standard price list quotes do not. Turnaround is usually two working days." '"sales","legal","pricing"' ''
learn $SVEN "$SVENN" l4 "A customer in the automotive sector requires a signed NDA before any demo" "Ask the account owner for the NDA template; it is on the Sales SharePoint under Templates/NDA. Do not share screenshots or sample data before it is signed." '"sales","clients","process"' ''
learn $ELI "$ELIN" l5 "The export service needs the VPN for NuGet restore" "dotnet restore in acme.export.* fails with a timeout when off the VPN because nuget.config points at Nexus. This is a setup problem, not a broken repo." '"engineering","ci","tooling"' ',"repo":"acme.export.api","confidence":"high"'
learn $ELI "$ELIN" l6 "Run tests with the repo runTest.sh, never bare dotnet test" "runTest.sh is what CI runs: it wires loggers, coverage and dependency containers. Check it starts with set -ex or a failing test exits 0 and CI goes silently green." '"engineering","ci","testing"'
learn $ELI "$ELIN" l7 "kubectl contexts: dev-acme is the default, prod-acme exists too" "Check the current context before running anything. It can be left on prod after an incident. Give az and kubectl calls an explicit timeout: they hang rather than fail when the VPN is down." '"engineering","kubernetes","tooling"'
learn $LEA "$LEAN" l8 "Client names never go into shared notes; describe the sector instead" "Write a customer in the pharma sector, not the company name. The memory masks what it recognises but recognition is best effort; the responsibility is ours." '"legal","process","security"' ',"confidence":"high"'
learn $PRIYA "$PRIYAN" l9 "Board decks go through Sam before the Thursday cut-off" "Send the near-final deck to Sam by Wednesday noon. Thursday 16:00 is the cut-off for the board pack; anything after that waits a month." '"management","process"'
learn $PRIYA "$PRIYAN" l10 "Quarterly OKR reviews use the template in Management/OKR/2026" "One slide per objective, red-amber-green on the key results, no more than three risks. Reviews are the first Monday of the quarter." '"management","process","templates"'

# votes and kudos from other people
ID1=$(curl -s "$O/api/learnings?q=utm%20naming&limit=1" -H "X-Bab-Actor-Email: $ELI" -H "X-Bab-Actor-Name: $ELIN" | python -c "import sys,json; print(json.load(sys.stdin)['results'][0]['id'])")
ID5=$(curl -s "$O/api/learnings?q=nuget%20restore&limit=1" -H "X-Bab-Actor-Email: $ELI" -H "X-Bab-Actor-Name: $ELIN" | python -c "import sys,json; print(json.load(sys.stdin)['results'][0]['id'])")
ID3=$(curl -s "$O/api/learnings?q=pricing%20legal%20review&limit=1" -H "X-Bab-Actor-Email: $ELI" -H "X-Bab-Actor-Name: $ELIN" | python -c "import sys,json; print(json.load(sys.stdin)['results'][0]['id'])")
post $ELI "$ELIN" "/api/learnings/$ID1/vote" v1 '{"kind":"helpful"}'
post $SVEN "$SVENN" "/api/learnings/$ID1/vote" v2 '{"kind":"helpful"}'
post $ELI "$ELIN" "/api/learnings/$ID1/kudos" k1 '{"note":"Saved me a guess on the newsletter links"}'
post $PRIYA "$PRIYAN" "/api/learnings/$ID5/vote" v3 '{"kind":"helpful"}'
post $LEA "$LEAN" "/api/learnings/$ID3/kudos" k2 '{"note":"Exactly the rule, thank you"}'

# conversations
post $ELI "$ELIN" /api/messages m1 "{\"to\":\"$MAYA\",\"subject\":\"UTM product code for the newsletter\",\"body\":\"Is esg also the product code for the sustainability newsletter, or does the newsletter have its own?\"}"
T1=$(curl -s "$O/api/inbox" -H "X-Bab-Actor-Email: $MAYA" -H "X-Bab-Actor-Name: $MAYAN" | python -c "import sys,json; d=json.load(sys.stdin); t=d.get('threads',d); print(t[0]['thread']['id'])")
post $MAYA "$MAYAN" /api/messages m2 "{\"threadId\":\"$T1\",\"body\":\"Yes, esg for all Q4 sustainability content, newsletter included. Region stays eu.\"}"
post $ELI "$ELIN" /api/messages m3 "{\"threadId\":\"$T1\",\"body\":\"Thanks. Using utm_campaign=q4-eu-esg on all six links.\"}"
post $SVEN "$SVENN" /api/messages m4 "{\"to\":\"$LEA\",\"subject\":\"Multi-year quote for an automotive prospect\",\"body\":\"Three-year term with a custom SLA. Can Legal look at the draft this week?\"}"
T2=$(curl -s "$O/api/inbox" -H "X-Bab-Actor-Email: $LEA" -H "X-Bab-Actor-Name: $LEAN" | python -c "import sys,json; d=json.load(sys.stdin); t=d.get('threads',d); print(t[0]['thread']['id'])")
post $LEA "$LEAN" /api/messages m5 "{\"threadId\":\"$T2\",\"body\":\"Yes. Send the draft to the legal inbox and tag it multi-year; two working days.\"}"
post $PRIYA "$PRIYAN" /api/messages m6 "{\"to\":\"$ELI\",\"subject\":\"Board pack numbers\",\"body\":\"Which dashboard has the September deployment counts? I need them for Thursday.\"}"

post $SVEN "$SVENN" /api/todos t1 '{"title":"Re-check the pricing approval for the automotive prospect","dueAt":"2026-10-01","body":"Open the quote, confirm legal sign-off is attached, then send. Undo: withdraw the quote in the CRM."}'
echo done
