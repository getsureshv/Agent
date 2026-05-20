FROM node:20-alpine AS base

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy application source (static assets + server code)
COPY . .

EXPOSE 3000

# Migrations run at boot inside server.js before the HTTP server starts.
CMD ["node", "server.js"]
