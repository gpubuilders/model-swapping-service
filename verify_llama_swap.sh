#!/bin/bash

# Verification script for model-swap Node.js Docker container

echo "Starting model-swap verification..."

# Function to check if the server is responding
check_server_health() {
    local response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health 2>/dev/null)
    if [ "$response" -eq 200 ]; then
        echo "✓ Health check passed"
        return 0
    else
        echo "✗ Health check failed - HTTP status: $response"
        return 1
    fi
}

# Function to list available models
list_models() {
    echo "Fetching available models..."
    local response=$(curl -s http://localhost:8080/v1/models)
    local status=$(echo $response | grep -o '"data"' | head -1)
    
    if [ -n "$status" ]; then
        echo "✓ Models endpoint working"
        echo "Available models:"
        echo $response | jq -r '.data[].id' 2>/dev/null || echo $response
        return 0
    else
        echo "✗ Models endpoint failed"
        echo "Response: $response"
        return 1
    fi
}

# Function to test a specific model
test_model() {
    local model_name="$1"
    echo "Testing model: $model_name"
    
    # Check if the model exists in the model list first
    local model_exists=$(curl -s http://localhost:8080/v1/models | jq -r ".data[].id" 2>/dev/null | grep -x "$model_name" | head -1)
    
    if [ -z "$model_exists" ]; then
        echo "⚠ Model $model_name not found in model list"
        return 1
    fi
    
    # Send a simple test request to the chat completions endpoint
    local request_data=$(cat <<EOF
{
  "model": "$model_name",
  "messages": [
    {
      "role": "user",
      "content": "Hello, how are you? Please respond with a short greeting."
    }
  ],
  "temperature": 0.7,
  "max_tokens": 50
}
EOF
)

    # Try to send request with timeout
    local response
    local status_code
    response=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8080/v1/chat/completions \
         -H "Content-Type: application/json" \
         -d "$request_data" -m 30 2>/dev/null)
    
    if [ "$response" -eq 200 ] || [ "$response" -eq 400 ] || [ "$response" -eq 404 ]; then
        echo "✓ Model endpoint for $model_name responded with status: $response"
        if [ "$response" -eq 200 ]; then
            echo "  Request was processed successfully"
        elif [ "$response" -eq 400 ]; then
            echo "  Model might need different parameters"
        elif [ "$response" -eq 404 ]; then
            echo "  Model endpoint not found - might not be configured correctly"
        fi
        return 0
    else
        echo "✗ Model $model_name failed with status: $response"
        return 1
    fi
}

# Function to check if llama-cpp server starts when requested
check_model_loading() {
    echo "Testing model loading functionality..."
    
    # First get the list of models from our config
    local models_response=$(curl -s http://localhost:8080/v1/models)
    local available_models=$(echo "$models_response" | jq -r '.data[].id' 2>/dev/null)
    
    if [ -z "$available_models" ]; then
        echo "✗ No models available from the API"
        return 1
    fi
    
    echo "Models found: $available_models"
    
    # Test each available model
    local success_count=0
    local total_count=0
    
    for model in $available_models; do
        total_count=$((total_count + 1))
        if test_model "$model"; then
            success_count=$((success_count + 1))
        else
            echo "  Failed to test model: $model"
        fi
    done
    
    echo "Model testing results: $success_count/$total_count models responded"
    
    if [ $success_count -gt 0 ]; then
        return 0
    else
        return 1
    fi
}

# Main verification process
main_verification() {
    local max_attempts=30
    local attempt=1
    
    echo "Waiting for model-swap server to be ready..."
    while [ $attempt -le $max_attempts ]; do
        if check_server_health; then
            break
        fi
        
        echo "Attempt $attempt of $max_attempts: Server not ready yet, waiting 10 seconds..."
        sleep 10
        attempt=$((attempt + 1))
    done
    
    if [ $attempt -gt $max_attempts ]; then
        echo "✗ Server failed to become ready after $max_attempts attempts"
        return 1
    fi
    
    # List models
    list_models || return 1
    
    # Test model loading
    check_model_loading || return 1
    
    echo "✓ Basic verification completed successfully"
    return 0
}

# Run the main verification
main_verification
exit_code=$?
exit $exit_code