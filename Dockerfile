# Node 22 + ffmpeg. No npm dependencies, so the build only needs apt for ffmpeg.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy sources (there are no runtime deps to install).
COPY package.json ./
COPY tools ./tools
COPY README.md ./

# Default: print CLI help so `docker compose up --build` builds and exits cleanly.
CMD ["node", "tools/compositor.mjs", "--help"]
