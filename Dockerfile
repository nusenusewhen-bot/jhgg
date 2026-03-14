FROM node:18-slim

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DISPLAY=:99

RUN apt-get update && apt-get install -y \
    chromium xvfb libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
CMD xvfb-run -a node bot.js
