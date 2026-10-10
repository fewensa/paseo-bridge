FROM node:24-alpine@sha256:83f1c388c31fb2e51f7cbd4dea949b96260798c98f206e8e4696bc93bd964e3a AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json cli.ts server.ts container.ts ./
COPY src ./src
COPY scripts/bundle.mjs scripts/redoc-assets.mjs ./scripts/
COPY assets ./assets
RUN npm run check && npm run bundle

FROM node:24-alpine@sha256:83f1c388c31fb2e51f7cbd4dea949b96260798c98f206e8e4696bc93bd964e3a
WORKDIR /opt/paseo-bridge
COPY --from=build /app/build/paseo-bridge.mjs /app/build/paseo-bridge-server.mjs /app/build/paseo-bridge-container.mjs ./
RUN mkdir -p /var/lib/paseo-bridge /run/paseo-bridge \
    && chown node:node /var/lib/paseo-bridge /run/paseo-bridge \
    && chmod 700 /var/lib/paseo-bridge /run/paseo-bridge \
    && ln -s /opt/paseo-bridge/paseo-bridge.mjs /usr/local/bin/paseo-bridge
USER 1000:1000
ENTRYPOINT ["node", "/opt/paseo-bridge/paseo-bridge-container.mjs"]
CMD ["--config", "/etc/paseo-bridge/bridge.json"]
