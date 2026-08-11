FROM node:22-bookworm-slim

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

WORKDIR /app
COPY deploy/cloud-app/requirements.txt /tmp/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY config/ ./config/
COPY packages/ ./packages/

ENV NODE_ENV=production \
    ONYXCLAW_E2B_PYTHON=/opt/venv/bin/python \
    APP_HOST=0.0.0.0 \
    APP_PORT=3000 \
    CHANNEL_HOST=0.0.0.0 \
    CHANNEL_PORT=18890

USER node
EXPOSE 3000 18890
CMD ["node", "packages/cloud-runtime/src/cloud-app.js"]
