FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=12081

WORKDIR /app

# Web UI + unified relay server runtime.
COPY unified-server.js ./
COPY dev-admin.html ./
COPY dist ./dist
COPY signaling-server/package*.json ./signaling-server/

RUN npm install --omit=dev --no-audit --no-fund --no-save lzbase62@^2.0.0 \
    && cd signaling-server && npm ci --omit=dev --no-audit --no-fund

# Persistent data lives here. Mount this in TrueNAS Apps.
RUN mkdir -p /app/data/rooms /app/data/media
VOLUME ["/app/data"]

EXPOSE 12081

CMD ["node", "unified-server.js"]
