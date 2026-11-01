# API image. Build from this folder: docker build -t ug-arms-api .
# Node 24 (the current Active LTS line) on Debian 13, which carries fewer unpatched OS vulnerabilities than Debian 12.
FROM node:24-trixie-slim
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# The npm and corepack tools are removed after installing dependencies: the running service never needs them,
# and they carry their own vulnerable dependencies (found by an image scan on 30 October 2026).
RUN npm ci --omit=dev && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p uploads/tmp logs && chown -R node:node /app
USER node
EXPOSE 4200
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:4200/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
