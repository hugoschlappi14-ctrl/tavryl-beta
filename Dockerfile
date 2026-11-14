FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libfontconfig1 libgl1 libx11-6 libxcursor1 \
    libxinerama1 libxrandr2 libxi6 libasound2 libpulse0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY hosting/package.json hosting/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
RUN curl --fail --location --retry 3 \
    https://github.com/hugoschlappi14-ctrl/tavryl-beta/releases/download/v0.18.17/tavryl-server \
    --output /app/tavryl-server \
    && echo '83ec04a076c3955fa5cab78ac363c122f9aa8d9e08daa7bc0622a25da4f0d9e2  /app/tavryl-server' | sha256sum --check \
    && chmod 755 /app/tavryl-server
COPY hosting/host.mjs hosting/state.mjs hosting/admin-store.mjs hosting/admin-http.mjs hosting/socket-upgrade.mjs hosting/probe-guard.mjs hosting/admin.html hosting/admin.js hosting/admin.css ./
ENV TAVRYL_PUBLIC_BETA=1 NODE_ENV=production PORT=10000 XDG_DATA_HOME=/tmp/tavryl-data
USER node
EXPOSE 10000
CMD ["node", "host.mjs"]
