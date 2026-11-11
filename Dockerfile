FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=9090
RUN apk add --no-cache python3 py3-psycopg2
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/scripts/sync_schema.py ./scripts/sync_schema.py
COPY --from=build --chown=node:node /app/scripts/start.sh ./scripts/start.sh
COPY --from=build --chown=node:node /app/db ./db
RUN mkdir -p /var/serivce/operator-agent-service/log && chown -R node:node /var/serivce
ENV SERVICE_NAME=operator-agent-service
USER node
EXPOSE 9090
CMD ["sh", "/app/scripts/start.sh"]
