FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libfontconfig1 libgl1 libx11-6 libxcursor1 \
    libxinerama1 libxrandr2 libxi6 libasound2 libpulse0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY hosting/package.json hosting/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
RUN curl --fail --location --retry 3 \
    https://github.com/hugoschlappi14-ctrl/tavryl-beta/releases/download/v0.18.1-host-preview/tavryl-server-r2 \
    --output /app/tavryl-server \
    && echo '58a453cb6ac4dbd23da98bcdb0c9d306a64075964152263b2af621ac8ee4b476  /app/tavryl-server' | sha256sum --check \
    && chmod 755 /app/tavryl-server
COPY hosting/host.mjs hosting/state.mjs ./
ENV NODE_ENV=production PORT=10000 XDG_DATA_HOME=/tmp/tavryl-data
USER node
EXPOSE 10000
CMD ["node", "host.mjs"]
