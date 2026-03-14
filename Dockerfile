FROM node:18-slim

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DISPLAY=:99 \
    TMPDIR=/tmp

RUN apt-get update && apt-get install -y \
    chromium xvfb xauth libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 libasound2 \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Create tmp with proper perms
RUN mkdir -p /tmp && chmod 777 /tmp

CMD xvfb-run -a --error-file=/dev/null --server-args="-screen 0 1920x1080x24" node bot.js
