# Stage 1: Build
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /build

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/worker/package.json packages/worker/tsconfig.json ./packages/worker/
COPY packages/dispatcher/package.json packages/dispatcher/tsconfig.json ./packages/dispatcher/

RUN pnpm install --frozen-lockfile

COPY packages/shared/src/ ./packages/shared/src/
COPY packages/worker/src/ ./packages/worker/src/
RUN pnpm build

RUN pnpm --filter @kitten/worker --prod deploy --legacy /deploy

# Stage 2: Runtime
FROM node:22-alpine AS runtime

# git required by simple-git for clone operations
RUN apk add --no-cache git

COPY --from=build /deploy /app
WORKDIR /app

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
