# Baileys habla con WhatsApp por websocket: ya no hace falta Chromium ni sus
# librerías del sistema, y la imagen pasa de ~1 GB a ~200 MB.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
