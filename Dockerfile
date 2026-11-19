# API image. Build from this folder: docker build -t ug-arms-api .
# Node 24 (the current Active LTS line) on Debian 13, which carries fewer unpatched OS vulnerabilities than Debian 12.
FROM node:24-trixie-slim
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Defaults for running inside Docker, so a container needs no copied .env file. They match the service names and
# internal ports in the project's docker-compose.yml and are safe production choices (JSON logs, secure cookies, no
# demonstration data, malware scanning on). Anything set when the container runs (compose "environment", an env
# file, or the platform's environment settings such as Dokploy's) overrides them.
# Never put secrets here: anyone who can pull an image can read its ENV. Supply these at run time instead:
#   DB_USER, DB_PASSWORD, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, S3_ACCESS_KEY, S3_SECRET_KEY,
#   S3_DISPOSAL_ACCESS_KEY and S3_DISPOSAL_SECRET_KEY (API only), SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD,
#   MAIL_FROM, PUBLIC_APP_URL, CORS_ORIGINS, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD (first start only).
ENV NODE_ENV=production \
    PORT=4200 \
    LOG_FORMAT=json \
    DB_HOST=mssql \
    DB_PORT=1433 \
    DB_NAME=ug_arms \
    REDIS_URL=redis://redis:6379 \
    STORAGE_DRIVER=s3 \
    S3_ENDPOINT=http://seaweedfs:8333 \
    S3_BUCKET=ug-arms-objects \
    S3_REGION=us-east-1 \
    S3_FORCE_PATH_STYLE=true \
    CLAMAV_ENABLED=true \
    CLAMAV_HOST=clamav \
    CLAMAV_PORT=3310 \
    TIKA_URL=http://tika:9998 \
    OPENSEARCH_URL=http://opensearch:9200 \
    TRUST_PROXY=true \
    COOKIE_SECURE=true \
    SEED_DEMO_DATA=false
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
