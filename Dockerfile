FROM node:20-slim

# Install system dependencies the app expects (curl fallback, plus basic utils)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Ensure the data directory exists (app writes JSON db here)
RUN mkdir -p /app/data

# App reads secrets at runtime from Railway Variables — never bake them into the image
ENV NODE_ENV=production

# The app listens on this port by default (Railway injects $PORT automatically)
EXPOSE 3000

CMD ["node", "index.js"]
