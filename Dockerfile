FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
RUN mkdir -p /var/serivce/operator-agent-service/log && chown -R node:node /var/serivce
ENV SERVICE_NAME=operator-agent-service
USER node
EXPOSE 3000
CMD ["node", "server.js"]
