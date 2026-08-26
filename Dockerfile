FROM node:20-slim

WORKDIR /app

# Install openssl for prisma
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies and generate prisma client
RUN npm ci --omit=dev && npx prisma generate

# Copy source code and assets
COPY server.js ./
COPY src ./src/
COPY public ./public/
COPY scripts ./scripts/

EXPOSE 3003

CMD ["node", "server.js"]
