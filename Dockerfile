# Container image for the Streamable HTTP transport (remote MCP connector).
#
#   npm run clients                      # the client tarballs in .clients/ (not on npm yet)
#   docker build -t hardcharger-mcp .
#   docker run --rm -p 3000:3000 \
#     -e HARDCHARGER_URI=hardcharger://db.example.com \
#     -e HARDCHARGER_USERNAME=... -e HARDCHARGER_PASSWORD=... \
#     -e HARDCHARGER_MCP_PUBLIC_URL=https://mcp.example.com/mcp \
#     -e HARDCHARGER_MCP_OAUTH_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0 \
#     -e HARDCHARGER_MCP_OAUTH_AUDIENCE=<client-id> \
#     hardcharger-mcp
#
# Everything is JavaScript (no native driver), so one build serves linux/amd64 and
# linux/arm64 alike.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY .clients ./.clients
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json LICENSE README.md CHANGELOG.md ./
COPY .clients ./.clients
RUN npm ci --omit=dev --ignore-scripts && rm -rf .clients && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["node", "dist/cli.js", "--transport", "http", "--host", "0.0.0.0"]
CMD ["--port", "3000"]
