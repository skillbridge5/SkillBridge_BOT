FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY bot.js ./
COPY questions.json ./

RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup && \
    mkdir -p /app/data && chown -R appuser:appgroup /app

USER appuser

VOLUME /app/data

ENV NODE_ENV=production
ENV DB_PATH=/app/data/skillbridge.db

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD pgrep -f "node bot.js" > /dev/null || exit 1

CMD ["node", "bot.js"]
