FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files + the postinstall script BEFORE npm install
COPY package*.json ./
COPY download-curl-impersonate.js ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "index.js"]
