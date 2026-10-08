# Open Shot Designer — self-hosted image.
#
#   docker build -t openshotdesigner:latest .
#   docker run -d -p 8080:8080 -v /path/to/data:/data openshotdesigner:latest
#
# Stage 1 builds the web app in "server storage" mode; stage 2 is a small
# Node runtime that serves it and stores everything under /data.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:server

FROM node:24-alpine
ARG APP_VERSION=1.0.2-selfhost
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist \
    APP_VERSION=${APP_VERSION}
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server
COPY LICENSE ./LICENSE
# /data must be writable by whichever UID the container runs as. The default is
# the image's "node" user (1000); on TrueNAS run it as 568 (apps) instead and
# give that user write access to the dataset.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "server/server.mjs"]
