#!/usr/bin/env bash
# Fire every sample webhook against a running dev server.
#
# Usage:  ./fixtures/webhook-payloads/fire-all.sh
# (assumes `npm run dev` is running on http://localhost:3000)
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
DIR="$(cd "$(dirname "$0")" && pwd)"

fire() {
  local endpoint="$1"
  local payload="$2"
  local label="$3"
  echo "▶ $label"
  if command -v jq >/dev/null 2>&1; then
    curl -sS -X POST "${BASE_URL}${endpoint}" \
      -H 'Content-Type: application/json' \
      --data-binary "@${DIR}/${payload}" | jq .
  else
    curl -sS -X POST "${BASE_URL}${endpoint}" \
      -H 'Content-Type: application/json' \
      --data-binary "@${DIR}/${payload}"
  fi
  echo
}

fire /api/webhooks/email    email-alrajhi.json       'EMAIL — Alrajhi invoice (expected: AUTO_MATCHED)'
fire /api/webhooks/email    email-zamil-orphan.json  'EMAIL — Zamil orphan (expected: UNMATCHED)'
fire /api/webhooks/whatsapp whatsapp-alfanar.json    'WA — Alfanar ambiguous (expected: NEEDS_REVIEW)'
fire /api/webhooks/whatsapp whatsapp-marhaba.json    'WA — Marhaba tip-tolerant match (expected: AUTO_MATCHED)'
fire /api/webhooks/whatsapp whatsapp-petromin.json   'WA — Petromin (expected: AUTO_MATCHED)'
fire /api/webhooks/whatsapp whatsapp-garbage.json    'WA — Garbage OCR (expected: FAILED)'
fire /api/webhooks/email    email-alrajhi.json       'EMAIL — refire (expected: DUPLICATE)'
