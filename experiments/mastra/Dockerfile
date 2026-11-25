# Mastra track of the n8n versus Mastra experiment (#918).
# Build on the target architecture (linux/arm64): LibSQL ships native binaries.
FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npx tsc --noEmit && npx mastra build --studio

FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4111 MASTRA_STUDIO_PATH=/app/studio MASTRA_SKIP_DOTENV=1
WORKDIR /app
COPY --from=build /app/.mastra/output ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4111
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:4111/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "index.mjs"]
