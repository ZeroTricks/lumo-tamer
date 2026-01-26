#!/bin/bash
# Phase 2 API Integration Tests
# Run with: bash tests/phase2-api-integration.sh
#
# Prerequisites:
# - Server running: npm run dev
# - Valid auth tokens in sessions/auth-tokens.json

set -e

BASE_URL="${BASE_URL:-http://localhost:3003}"
API_KEY="${API_KEY}"

echo "=== Phase 2 API Integration Tests ==="
echo "Base URL: $BASE_URL"
echo ""

# Helper function for API calls
api_call() {
    local data="$1"
    curl -s -X POST "$BASE_URL/v1/chat/completions" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        -d "$data"
}

api_call_streaming() {
    local data="$1"
    curl -s -N -X POST "$BASE_URL/v1/chat/completions" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        -d @- <<< "$data"
}

# Test 1: Health endpoint
echo "--- Test 1: Health endpoint ---"
health_response=$(curl -s "$BASE_URL/health" -H "Authorization: Bearer $API_KEY")
echo "Response: $health_response"
if echo "$health_response" | grep -q '"status":"ok"'; then
    echo "✅ PASS: Health endpoint returns ok"
else
    echo "❌ FAIL: Health endpoint did not return ok"
    exit 1
fi
echo ""

# Test 2: Non-streaming chat completion
echo "--- Test 2: Non-streaming chat completion ---"
response=$(api_call '{"model":"lumo","messages":[{"role":"user","content":"What is 2+2? Answer with just the number."}],"stream":false}')
echo "Response: $response"
if echo "$response" | grep -q '"object":"chat.completion"'; then
    echo "✅ PASS: Non-streaming returns chat.completion object"
else
    echo "❌ FAIL: Non-streaming did not return expected format"
    exit 1
fi
if echo "$response" | grep -q '"finish_reason":"stop"'; then
    echo "✅ PASS: finish_reason is stop"
else
    echo "❌ FAIL: finish_reason not found"
    exit 1
fi
echo ""

# Test 3: Streaming chat completion
echo "--- Test 3: Streaming chat completion ---"
stream_response=$(api_call_streaming '{"model":"lumo","messages":[{"role":"user","content":"Say hi"}],"stream":true}')
echo "Response (first 500 chars): ${stream_response:0:500}"
if echo "$stream_response" | grep -q 'data: {"id":"chatcmpl-'; then
    echo "✅ PASS: Streaming returns SSE chunks"
else
    echo "❌ FAIL: Streaming did not return SSE format"
    exit 1
fi
if echo "$stream_response" | grep -q 'data: \[DONE\]'; then
    echo "✅ PASS: Streaming ends with [DONE]"
else
    echo "❌ FAIL: Streaming did not end with [DONE]"
    exit 1
fi
if echo "$stream_response" | grep -q '"finish_reason":"stop"'; then
    echo "✅ PASS: Streaming has final chunk with finish_reason"
else
    echo "❌ FAIL: Streaming missing finish_reason"
    exit 1
fi
echo ""

# Test 4: Multi-turn conversation
echo "--- Test 4: Multi-turn conversation ---"
response=$(api_call '{"model":"lumo","messages":[{"role":"user","content":"My name is TestUser"},{"role":"assistant","content":"Nice to meet you, TestUser!"},{"role":"user","content":"What is my name?"}],"stream":false}')
echo "Response: $response"
if echo "$response" | grep -qi 'TestUser'; then
    echo "✅ PASS: Multi-turn remembers context (found TestUser)"
else
    echo "❌ FAIL: Multi-turn did not remember context"
    exit 1
fi
echo ""

# Test 5: Command stub
echo "--- Test 5: Command stub (/new) ---"
response=$(api_call '{"model":"lumo","messages":[{"role":"user","content":"/new"}],"stream":false}')
echo "Response: $response"
if echo "$response" | grep -q 'not available in API mode'; then
    echo "✅ PASS: Command returns stub error message"
else
    echo "❌ FAIL: Command did not return expected error"
    exit 1
fi
echo ""

# Test 6: Unknown command
echo "--- Test 6: Unknown command ---"
response=$(api_call '{"model":"lumo","messages":[{"role":"user","content":"/unknowncommand"}],"stream":false}')
echo "Response: $response"
if echo "$response" | grep -q 'Unknown command'; then
    echo "✅ PASS: Unknown command returns error"
else
    echo "❌ FAIL: Unknown command did not return expected error"
    exit 1
fi
echo ""

# Test 7: System message injection
echo "--- Test 7: System message (instructions) ---"
response=$(api_call '{"model":"lumo","messages":[{"role":"system","content":"Always respond in French"},{"role":"user","content":"Hello"}],"stream":false}')
echo "Response: $response"
# We can't assert French response, but we can check it completes
if echo "$response" | grep -q '"finish_reason":"stop"'; then
    echo "✅ PASS: System message request completes successfully"
else
    echo "❌ FAIL: System message request failed"
    exit 1
fi
echo ""

# Test 8: Missing messages validation
echo "--- Test 8: Request validation (missing messages) ---"
response=$(curl -s -X POST "$BASE_URL/v1/chat/completions" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"lumo"}')
echo "Response: $response"
if echo "$response" | grep -q 'error'; then
    echo "✅ PASS: Missing messages returns error"
else
    echo "❌ FAIL: Missing messages did not return error"
    exit 1
fi
echo ""

echo "==================================="
echo "All tests passed!"
echo "==================================="
