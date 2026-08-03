# Stage 1: Install dependencies
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/reviewer/package.json packages/reviewer/

# Install production deps only
RUN pnpm install --prod --frozen-lockfile --filter @kitten/reviewer --filter @kitten/shared

# Copy built source
COPY packages/shared/dist/ packages/shared/dist/
COPY packages/reviewer/dist/ packages/reviewer/dist/

# Stage 2: Runtime
FROM node:20-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY --from=builder /app .

CMD ["node", "packages/reviewer/dist/index.js"]
