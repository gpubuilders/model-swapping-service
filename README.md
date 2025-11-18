# Llama Swap - Node.js Version

A reverse proxy for local LLM models with dynamic switching capabilities, implemented in Node.js.

## Features

- Reverse proxy for local LLM models (like llama.cpp's llama-server)
- Dynamic switching between models
- Configuration via YAML with macro substitution
- API endpoints compatible with OpenAI API format
- Graceful startup and shutdown
- Process management for llama-server instances
- Docker deployment support

## Requirements

- Node.js 18 or higher
- npm
- llama-server or vLLM (for running actual models)

## Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

## Usage

### Run locally

```bash
npm start
# or with custom config
npm start -- --config /path/to/config.yaml
```

### Run with Docker

The Docker image is based on the `ghcr.io/mostlygeek/model-swap:cuda` base image, which includes llama-server and vLLM.

```bash
# Build the image
docker build -t model-swap .

# Run the container
docker run -p 8080:8080 -v /path/to/config.yaml:/app/config.yaml model-swap

# For GPU support:
docker run --gpus all -p 8080:8080 -v /path/to/config.yaml:/app/config.yaml model-swap
```

## Configuration

The application uses a YAML configuration file. See `config.example.yaml` for a complete example of all available options.

### Key Configuration Options:

- `healthCheckTimeout`: Time in seconds to wait for a model to be ready
- `logLevel`: Logging level (debug, info, warn, error)
- `startPort`: Starting port number for automatic port assignment
- `models`: Dictionary of model configurations
- `groups`: Group models for advanced swapping behavior
- `macros`: Reusable configuration snippets

## API Endpoints

- `GET /v1/models` - List available models
- `POST /v1/chat/completions` - Chat completions API
- `POST /v1/completions` - Completions API
- `POST /v1/embeddings` - Embeddings API
- `GET /health` - Health check
- `GET /running` - List running models
- `GET /unload` - Unload all models

## Model Configuration

Each model in the configuration can specify:

- `cmd`: Command to start the model server
- `proxy`: URL where the model server is accessible
- `checkEndpoint`: Health check endpoint
- `aliases`: Alternative names for the model
- `env`: Environment variables
- And more...

## Process Management

The application manages model processes, starting them on-demand and stopping them when not in use (based on TTL or swapping rules).

## License

MIT