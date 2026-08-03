# Stage 1: Build
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /build

# Copy lockfile and workspace config first (layer caching)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/dispatcher/package.json packages/dispatcher/tsconfig.json ./packages/dispatcher/
COPY packages/worker/package.json packages/worker/tsconfig.json ./packages/worker/

# Install all deps (including devDeps for build)
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY packages/shared/src/ ./packages/shared/src/
COPY packages/dispatcher/src/ ./packages/dispatcher/src/
RUN pnpm build

# Bundle dispatcher + prod deps only
RUN pnpm --filter @kitten/dispatcher --prod deploy --legacy /deploy

# Stage 2: Runtime
FROM node:22-alpine AS runtime

COPY --from=build /deploy /app
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
