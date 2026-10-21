#!/bin/bash
# LinUCB Contextual Bandit API Test Suite
# Usage: ./tests/api/bandit.sh LOCAL (loopback only)

set -e

ENV=${1:-LOCAL}
if [ "$ENV" != "LOCAL" ]; then
  echo "This publication candidate permits loopback API tests only." >&2
  exit 2
fi
BASE_URL=${SOCRATIC_LOCAL_BASE_URL:-http://127.0.0.1:8787}
node -e '
const u = new URL(process.argv[1]);
if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.username || u.password || u.search || u.hash || !["", "/"].includes(u.pathname)) process.exit(2);
' "$BASE_URL" || { echo "Loopback HTTP URL required." >&2; exit 2; }

echo "=== LinUCB Contextual Bandit API Tests ==="
echo "Environment: $ENV"
echo "Base URL: $BASE_URL"
echo ""

# Test 1: Choose arm with valid context
echo "[TEST 1] POST /api/bandit/choose - Select arm"
CHOOSE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/bandit/choose" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "test-session-001",
    "context": [0.5, 0.6, 0.7, 0.25, 0.25, 0.25, 0.25, 0],
    "alpha": 0.5
  }')

echo "Response:"
echo "$CHOOSE_RESPONSE" | jq '.'
CHOSEN_ARM=$(echo "$CHOOSE_RESPONSE" | jq -r '.armId')
echo "Selected arm: $CHOSEN_ARM"
echo ""

# Test 2: Update arm with positive reward
echo "[TEST 2] POST /api/bandit/update - Update with positive reward"
UPDATE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/bandit/update" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "test-session-001",
    "armId": "'$CHOSEN_ARM'",
    "context": [0.5, 0.6, 0.7, 0.25, 0.25, 0.25, 0.25, 0],
    "reward": 0.8
  }')

echo "Response:"
echo "$UPDATE_RESPONSE" | jq '.'
echo ""

# Test 3: Choose arm again (should potentially prefer previously updated arm)
echo "[TEST 3] POST /api/bandit/choose - Second selection (after update)"
CHOOSE_RESPONSE_2=$(curl -s -X POST "$BASE_URL/api/bandit/choose" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "test-session-001",
    "context": [0.5, 0.6, 0.7, 0.25, 0.25, 0.25, 0.25, 0]
  }')

echo "Response:"
echo "$CHOOSE_RESPONSE_2" | jq '.'
echo ""

# Test 4: Invalid context dimension
echo "[TEST 4] Error handling - Invalid context dimension"
INVALID_RESPONSE=$(curl -s -X POST "$BASE_URL/api/bandit/choose" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "test-session-001",
    "context": [0.5, 0.6]
  }')

echo "Response (should be error):"
echo "$INVALID_RESPONSE" | jq '.'
echo ""

# Test 5: Multiple sessions
echo "[TEST 5] POST /api/bandit/choose - Different session"
CHOOSE_SESSION_2=$(curl -s -X POST "$BASE_URL/api/bandit/choose" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "test-session-002",
    "context": [0.3, 0.4, 0.5, 0.33, 0.33, 0.34, 0, 0]
  }')

echo "Response:"
echo "$CHOOSE_SESSION_2" | jq '.'
echo ""

echo "=== All tests completed ==="
