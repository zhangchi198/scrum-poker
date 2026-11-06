# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production PORT=3000 DATA_FILE=/data/rooms.json
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Node 24 runs the TypeScript server directly (type stripping), so there is no server build step.
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY --from=build /app/client/dist ./client/dist
RUN mkdir -p /data && chown node:node /data
# Commit SHA of this build, reported by /healthz (compose passes it; `dev` when built by hand). Last, so it never busts the layers above.
ARG GIT_SHA=dev
ENV APP_VERSION=$GIT_SHA
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "server/index.ts"]
