# Start from the llama.cpp base image with CUDA support
ARG BASE_TAG=server-cuda
FROM ghcr.io/ggml-org/llama.cpp:${BASE_TAG}

# Set versions and user/group arguments
ARG LS_VER=170
ARG UID=1001
ARG GID=1001
ARG USER_HOME=/app

# Switch to root for installation
USER root

# Remove or disable problematic NVIDIA repository to avoid sync errors
RUN rm -f /etc/apt/sources.list.d/cuda*.list || true && \
    rm -f /etc/apt/sources.list.d/nvidia*.list || true

# Install system dependencies, Python, and sudo
RUN apt-get update && \
    apt-get install -y \
    # Python and pip
    python3 \
    python3-pip \
    python3-dev \
    # Build tools
    build-essential \
    git \
    # System utilities
    sudo \
    curl \
    ca-certificates \
    gnupg2 \
    software-properties-common \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Set CUDA environment variables (should already be set in base image)
ENV PATH=/usr/local/cuda/bin:${PATH}
ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64:${LD_LIBRARY_PATH}
ENV CUDA_HOME=/usr/local/cuda

# Update pip to latest version and install/upgrade vLLM
RUN python3 -m pip install --upgrade pip && \
    python3 -m pip install --upgrade vllm

# Install Node.js 22.x
RUN curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh && \
    bash nodesource_setup.sh && \
    rm nodesource_setup.sh && \
    apt-get update && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Verify Node.js installation
RUN node --version && npm --version

# Create user/group if not root
ENV HOME=$USER_HOME
RUN if [ $UID -ne 0 ]; then \
      if [ $GID -ne 0 ] && ! getent group $GID > /dev/null 2>&1; then \
        groupadd --system --gid $GID model-swap; \
      fi; \
      if ! id -u $UID > /dev/null 2>&1; then \
        useradd --system --uid $UID --gid $GID \
        --home $USER_HOME --shell /bin/bash model-swap; \
      fi; \
    fi

# Add user to sudoers
RUN if [ $UID -ne 0 ]; then \
      echo "model-swap ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers; \
    fi

# Handle paths
RUN mkdir -p $HOME /app /models
RUN chown -R $UID:$GID $HOME /app /models

# Switch to app user
USER $UID:$GID

# Set working directory
WORKDIR /app


# Copy Node.js application files
COPY --chown=$UID:$GID package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy all source files
COPY --chown=$UID:$GID . .

# Build the UI
WORKDIR /app/ui
RUN npm install --legacy-peer-deps && npm run build

# Go back to app directory
WORKDIR /app

# Copy example config if no config exists
COPY --chown=$UID:$GID config.example.yaml /app/config.yaml

# Expose the default port
EXPOSE 8080

# Health check
HEALTHCHECK CMD curl -f http://localhost:8080/health || exit 1

# Start the Node.js application (which will manage model-swap internally)
ENTRYPOINT ["npm", "start"]