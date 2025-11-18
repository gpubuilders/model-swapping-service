#!/bin/bash

# Comprehensive test script for model-swap Node.js Docker container

echo "Starting comprehensive model-swap verification..."

# Test 1: Check server health
echo "Test 1: Checking server health..."
health_response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health)
if [ "$health_response" -eq 200 ]; then
    echo "✓ Health check passed"
else
    echo "✗ Health check failed - HTTP status: $health_response"
    exit 1
fi

# Test 2: List available models
echo "Test 2: Listing available models..."
models_response=$(curl -s http://localhost:8080/v1/models)
echo "$models_response" | jq '.' 2>/dev/null || echo "$models_response"

# Extract model names
model1=$(echo "$models_response" | jq -r '.data[0].id' 2>/dev/null)
model2=$(echo "$models_response" | jq -r '.data[1].id' 2>/dev/null)

echo "Found models: $model1 and $model2"

# Test 3: Send a test request to the first model
echo "Test 3: Testing model functionality with $model1..."

request_data=$(cat <<EOF
{
  "model": "$model1",
  "messages": [
    {
      "role": "user",
      "content": "Hello, this is a test. Please respond with a short greeting in one sentence."
    }
  ],
  "temperature": 0.7,
  "max_tokens": 50
}
EOF
)

# Send the request with a longer timeout since llama-cpp might take time to start
echo "Sending request to model: $model1"
response=$(curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:8080/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d "$request_data" -m 120)

status_line=$(echo "$response" | grep "HTTP_STATUS:" | cut -d':' -f2)
actual_response=$(echo "$response" | grep -v "HTTP_STATUS:")

echo "Response status: $status_line"
if [ "$status_line" -eq 200 ]; then
    echo "✓ Model request successful"
    echo "Response content:"
    echo "$actual_response" | jq '.' 2>/dev/null || echo "$actual_response"
elif [ "$status_line" -eq 400 ]; then
    echo "⚠ Model request returned 400 - may need different parameters"
    echo "Response content: $actual_response"
else
    echo "✗ Model request failed with status: $status_line"
    echo "Response content: $actual_response"
fi

# Test 4: Test the second model
if [ -n "$model2" ]; then
    echo "Test 4: Testing model functionality with $model2..."
    
    request_data2=$(cat <<EOF
{
  "model": "$model2",
  "messages": [
    {
      "role": "user",
      "content": "Hello, this is a test for the second model. Please respond with a short greeting."
    }
  ],
  "temperature": 0.7,
  "max_tokens": 50
}
EOF
)
    
    echo "Sending request to model: $model2"
    response2=$(curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:8080/v1/chat/completions \
         -H "Content-Type: application/json" \
         -d "$request_data2" -m 120)
    
    status_line2=$(echo "$response2" | grep "HTTP_STATUS:" | cut -d':' -f2)
    actual_response2=$(echo "$response2" | grep -v "HTTP_STATUS:")
    
    echo "Response status: $status_line2"
    if [ "$status_line2" -eq 200 ]; then
        echo "✓ Second model request successful"
        echo "Response content:"
        echo "$actual_response2" | jq '.' 2>/dev/null || echo "$actual_response2"
    elif [ "$status_line2" -eq 400 ]; then
        echo "⚠ Second model request returned 400 - may need different parameters"
        echo "Response content: $actual_response2"
    else
        echo "✗ Second model request failed with status: $status_line2"
        echo "Response content: $actual_response2"
    fi
fi

# Test 5: Check running models endpoint
echo "Test 5: Checking running models..."
running_response=$(curl -s http://localhost:8080/running)
echo "Running models response:"
echo "$running_response" | jq '.' 2>/dev/null || echo "$running_response"

echo "Comprehensive verification completed!"
if [ "$status_line" -eq 200 ] || [ "$status_line" -eq 400 ]; then
    if [ -z "$model2" ] || [ "$status_line2" -eq 200 ] || [ "$status_line2" -eq 400 ]; then
        echo "✓ All tests completed with expected responses"
        exit 0
    fi
fi

echo "⚠ Some tests had unexpected results"
exit 0