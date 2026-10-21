FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    DS_HOST=0.0.0.0 \
    DS_PORT=3210 \
    DS_CONFIG_PATH=/data/config.json \
    DS_DATA_DIR=/data/state \
    DS_PID_PATH=/tmp/ds2api.pid

COPY --chown=node:node server.js config.example.json ./
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node docker/entrypoint.js ./docker/entrypoint.js
RUN set -eu; test -s lib/sha3_wasm.wasm; mkdir -p /data; chown node:node /data

USER node
EXPOSE 3210
CMD ["node", "docker/entrypoint.js"]
