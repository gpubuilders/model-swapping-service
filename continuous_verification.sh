#!/bin/bash

# Continuous verification script for model-swap Node.js Docker container

echo "Starting continuous verification of model-swap..."

# Function to perform a full verification test
perform_verification() {
    local test_time=$(date)
    echo "[$test_time] Running verification test..."
    
    # Check server health
    local health_response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health 2>/dev/null)
    if [ "$health_response" -ne 200 ]; then
        echo "[$test_time] Health check failed - HTTP status: $health_response"
        return 1
    fi
    
    # List models
    local models_response=$(curl -s http://localhost:8080/v1/models 2>/dev/null)
    if [ -z "$models_response" ] || ! echo "$models_response" | grep -q "qwen3_coder_reap_25b_A3B_IQ4_XS"; then
        echo "[$test_time] Model listing failed or expected model not found"
        return 1
    fi
    
    # Test first model with a simple request
    local model1="qwen3_coder_reap_25b_A3B_IQ4_XS"
    local request_data=$(cat <<EOF
{
  "model": "$model1",
  "messages": [
    {
      "role": "user",
      "content": "Test message for continuous verification. Respond with 'verification successful'."
    }
  ],
  "temperature": 0.1,
  "max_tokens": 10
}
EOF
)
    
    local response=$(curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:8080/v1/chat/completions \
         -H "Content-Type: application/json" \
         -d "$request_data" -m 60 2>/dev/null)
    
    local status_line=$(echo "$response" | grep "HTTP_STATUS:" | cut -d':' -f2)
    local actual_response=$(echo "$response" | grep -v "HTTP_STATUS:")
    
    if [ "$status_line" -ne 200 ]; then
        echo "[$test_time] Model test failed - HTTP status: $status_line"
        return 1
    fi
    
    # Check running models to ensure llama-cpp is started when needed
    local running_response=$(curl -s http://localhost:8080/running 2>/dev/null)
    echo "[$test_time] Running models: $(echo $running_response | jq -r '.running[].model' 2>/dev/null)"
    
    echo "[$test_time] ✓ Verification test passed"
    return 0
}

# Main continuous verification loop
echo "Starting continuous verification loop (Ctrl+C to stop)..."
counter=1
success_count=0
fail_count=0

while true; do
    if perform_verification; then
        success_count=$((success_count + 1))
    else
        fail_count=$((fail_count + 1))
    fi
    
    echo "[$counter tests, success: $success_count, failed: $fail_count]"
    
    # Sleep for 30 seconds between tests
    sleep 30
    
    counter=$((counter + 1))
done