ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.5.28
FROM ${OPENCLAW_IMAGE}

USER root
RUN test -x /bin/bash \
    && command -v setpriv \
    && command -v cp \
    && command -v mv \
    && command -v mkdir \
    && install -d -m 0755 -o node -g node /run/e2b /opt/onyxclaw/channel /opt/onyxclaw/bin

COPY --chown=node:node packages/onyxclaw-channel/ /opt/onyxclaw/channel/
COPY --chown=node:node iac/alicloud-acs/image/entrypoint.sh /opt/onyxclaw/bin/entrypoint.sh
RUN chmod 0755 /opt/onyxclaw/bin/entrypoint.sh \
    && cd /opt/onyxclaw/channel \
    && npm install --omit=dev --omit=peer --ignore-scripts \
    && ln -s /app /opt/onyxclaw/channel/node_modules/openclaw

USER root
ENV HOME=/home/node \
    OPENCLAW_HOME=/home/node \
    OPENCLAW_STATE_DIR=/home/node/.openclaw \
    OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
    OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace \
    ONYXCLAW_BOOTSTRAP_DIR=/home/node/.openclaw/bootstrap

ENTRYPOINT ["tini", "-s", "--", "/bin/bash", "/opt/onyxclaw/bin/entrypoint.sh"]
