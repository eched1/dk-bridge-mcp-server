FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

RUN mkdir -p /data && chown node:node /data

EXPOSE 3847
ENV MCP_TRANSPORT=http
ENV PORT=3847
ENV BRIDGE_STORE_PATH=/data/bridge-tasks.json

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3847/healthz || exit 1

USER node
CMD ["node", "dist/index.js"]
