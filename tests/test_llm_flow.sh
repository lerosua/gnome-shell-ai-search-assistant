#!/usr/bin/env bash

set -euo pipefail

DEFAULT_BASE_URL="https://yunwu.ai"
API_PATH="/v1/chat/completions"
MODEL="gpt-5-mini"

BASE_URL="${YUNWU_BASE_URL:-}"
if [[ -z "$BASE_URL" ]]; then
    BASE_URL="$(gsettings get org.gnome.shell.extensions.ai-search-assistant base-url 2>/dev/null | tr -d "'" || true)"
fi
if [[ -z "$BASE_URL" ]]; then
    BASE_URL="$DEFAULT_BASE_URL"
fi

BASE_URL="${BASE_URL%/}"
API_URL="${BASE_URL}${API_PATH}"

API_KEY="${YUNWU_API_KEY:-${SILICONFLOW_API_KEY:-}}"
if [[ -z "$API_KEY" ]]; then
    API_KEY="$(gsettings get org.gnome.shell.extensions.ai-search-assistant api-key 2>/dev/null | tr -d "'" || true)"
fi

if [[ -z "$API_KEY" ]]; then
    echo "[FAIL] No API key found. Set YUNWU_API_KEY or gsettings api-key"
    exit 2
fi

PAYLOAD="$(MODEL="$MODEL" python3 - <<'PY'
import json
import os
print(json.dumps({
    "model": os.environ["MODEL"],
    "messages": [
        {"role": "user", "content": "Reply with OK only."}
    ],
    "temperature": 0.7
}, ensure_ascii=True))
PY
)"

TMP_BODY="$(mktemp)"
HTTP_CODE="$(curl -sS -o "$TMP_BODY" -w "%{http_code}" "$API_URL" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")"

cleanup() {
    rm -f "$TMP_BODY"
}
trap cleanup EXIT

if [[ "$HTTP_CODE" != "200" ]]; then
    echo "[FAIL] LLM request failed (HTTP $HTTP_CODE)"
    echo "Response:"
    cat "$TMP_BODY"
    exit 1
fi

python3 - "$TMP_BODY" <<'PY'
import sys
import json

path = sys.argv[1]
data = json.load(open(path, "r", encoding="utf-8"))
content = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()

if not content:
    print("[FAIL] Empty model response")
    sys.exit(1)

print("[PASS] LLM flow is reachable and API key is valid")
print(f"Model reply: {content}")
PY
