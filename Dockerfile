# Sudo Sapient: one Node process serves the API and the built client.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATABASE_PATH=/data/sudo-sapient.db UPLOAD_DIR=/data/uploads
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src/core ./src/core
COPY package.json ./
COPY docker-entrypoint.sh /usr/local/bin/
# The database and uploaded files live on /data: mount a persistent volume there. (No VOLUME line:
# Railway rejects it.) Backups (`node server/scripts/backup.js`, or daily in the server with
# BACKUP_DIR set) go to BACKUP_DIR; without it the script writes /data/backups, on the same disk.
# The container starts as root only so the entrypoint can give root-owned mounts to `node`; the
# app itself always runs as `node`.
RUN mkdir -p /data/uploads /backups && chown -R node:node /data /backups
EXPOSE 8787
# The slim image has no curl; Node's fetch checks the API (and its database) is answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
