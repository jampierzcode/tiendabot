# Chromium necesita librerías del sistema (libglib, nss, fuentes…) que la imagen
# por defecto de Railway no trae: sin ellas whatsapp-web.js muere con
# "error while loading shared libraries: libglib-2.0.so.0" (código 127).
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*

# Se usa el Chromium del sistema, no el que descarga puppeteer.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
