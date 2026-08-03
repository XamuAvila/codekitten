# Single-stage build — simple, functional for dev/minikube
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Copy workspace
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/dispatcher/ ./packages/dispatcher/
COPY packages/reviewer/package.json packages/reviewer/tsconfig.json ./packages/reviewer/

# Install and build
RUN pnpm install --frozen-lockfile && pnpm build

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "packages/dispatcher/dist/index.js"]
