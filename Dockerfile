FROM node:18-slim

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DISPLAY=:99 \
    XVFB_WHD=1920x1080x24

RUN apt-get update && apt-get install -y \
    chromium xvfb xauth libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

CMD rm -rf /tmp/.X99-lock 2>/dev/null; xvfb-run -a --server-args="-screen 0 1920x1080x24" node bot.js
