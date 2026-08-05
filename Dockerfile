FROM node:22.14-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

COPY .next/standalone ./

COPY public ./public
COPY .next/static ./.next/static

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000
CMD ["npm", "run", "start"]

# FROM node:22.14-alpine AS runner
# WORKDIR /app

# COPY --from=builder /app/.next/standalone ./

# COPY --from=builder /app/public ./public
# COPY --from=builder /app/.next/static ./.next/static

# ENV NODE_ENV=production
# ENV PORT=3000
# EXPOSE 3000

# CMD ["node", "server.js"]
