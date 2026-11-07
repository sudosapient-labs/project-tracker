# Sudo Tracker, the Slack agent: its own image, built from the repository root
# (`docker build -f packages/slack-bot/Dockerfile .`) because it uses the workspace's client and MCP
# packages. Same pinned base image as the tracker's Dockerfile.
FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/client/package.json packages/client/
COPY packages/mcp/package.json packages/mcp/
COPY packages/slack-bot/package.json packages/slack-bot/
# Only the bot and the workspace packages it uses, production dependencies only.
RUN pnpm install --frozen-lockfile --prod --filter @sudosapient/slack-bot...
COPY packages/client packages/client
COPY packages/mcp/src packages/mcp/src
COPY packages/slack-bot/bin packages/slack-bot/bin
COPY packages/slack-bot/src packages/slack-bot/src

FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
WORKDIR /app
ENV NODE_ENV=production SLACK_BOT_DATA_DIR=/data PORT=3000
COPY --from=build /app /app
COPY packages/slack-bot/docker-entrypoint.sh /usr/local/bin/sudo-tracker-entrypoint
# Mappings, links, pending confirmations and conversations live on /data: mount a volume there.
RUN mkdir -p /data && chown node:node /data
# GET /health answers once the bot is connected to Slack (Socket Mode has no other HTTP).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
WORKDIR /app/packages/slack-bot
ENTRYPOINT ["sudo-tracker-entrypoint"]
CMD ["node", "bin/sudo-tracker.js"]
