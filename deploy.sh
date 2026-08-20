#!/bin/bash
set -e
cd ~/ToolWebsite
git pull origin main

# Check if Dockerfile changed by comparing with the running image
DOCKERFILE_CHANGED=false
if docker inspect converter --format='{{.Image}}' >/dev/null 2>&1; then
  if ! diff <(docker exec converter cat /app/Dockerfile 2>/dev/null || echo "") ~/ToolWebsite/Dockerfile >/dev/null 2>&1; then
    DOCKERFILE_CHANGED=true
  fi
else
  DOCKERFILE_CHANGED=true
fi

if [ "$DOCKERFILE_CHANGED" = true ]; then
  echo "Dockerfile changed or no container running - rebuilding image..."
  docker stop converter 2>/dev/null || true
  docker rm converter 2>/dev/null || true
  docker build -t livetools-converter .
  docker run -d --name converter --restart unless-stopped -p 3000:3000 livetools-converter
else
  echo "No Dockerfile changes - copying server.js only..."
  docker cp ~/ToolWebsite/server.js converter:/app/server.js
  docker restart converter
fi

echo "Deploy complete!"
