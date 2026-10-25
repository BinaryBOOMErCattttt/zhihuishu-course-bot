FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4319 \
    HEADLESS=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npx playwright install --with-deps chromium

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY config.example.json ./
COPY README.md LICENSE ./

RUN mkdir -p /app/data /app/shots /app/profile

EXPOSE 4319
VOLUME ["/app/profile", "/app/data", "/app/shots"]

CMD ["node", "server.js"]
