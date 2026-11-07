ARG BUILD_FROM
FROM ${BUILD_FROM}
RUN apk add --no-cache nodejs npm bash curl \
    && npm install --global --omit=dev mcporter@0.12.3 \
    && node --version
COPY app/authz.mjs app/broker.mjs app/ha-mcp-adapter.mjs app/http-server.mjs app/mcporter-invoker.mjs app/package.json /app/
COPY rootfs/ /
RUN chmod 0755 /usr/local/bin/hal-broker-start /etc/services.d/hal_automation_broker/run \
    && mkdir -p /data /config && chmod 0700 /data
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 CMD curl -fsS http://127.0.0.1:8765/healthz >/dev/null || exit 1
WORKDIR /app