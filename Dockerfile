FROM node:22.14-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22.14-alpine AS runner
WORKDIR /app

COPY --from=builder /app/.next/standalone ./

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
