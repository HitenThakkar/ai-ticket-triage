# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` when a lockfile is present (reproducible), `npm install` otherwise.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Run unprivileged. The node image already ships a `node` user.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src

USER node
EXPOSE 3000

# Init process so SIGTERM reaches node and graceful shutdown actually runs.
CMD ["node", "src/server.js"]
