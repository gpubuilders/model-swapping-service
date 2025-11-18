#!/bin/bash
set -e

IMAGE_NAME="model-swap-node"
TAG="${1:-latest}"

echo "Building ${IMAGE_NAME}:${TAG}..."

docker build \
  --build-arg UID=1001 \
  --build-arg GID=1001 \
  --build-arg BASE_TAG=server-cuda \
  --build-arg LS_VER=170 \
  -t ${IMAGE_NAME}:${TAG} \
  .

echo "Build complete: ${IMAGE_NAME}:${TAG}"