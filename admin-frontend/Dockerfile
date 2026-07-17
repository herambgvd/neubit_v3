# ── Neubit super-admin frontend — PRODUCTION multi-stage (Next.js standalone) ──
# Base compose builds the default (runner) target → a SELF-CONTAINED prod image
# that runs `node server.js`; NO source is needed at runtime. The dev override
# builds the `deps` target + bind-mounts source + runs `npm run dev` for hot-reload.

# deps — install node_modules once (reused by the dev override + the builder).
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

# builder — compile the optimized production build (Next standalone output).
FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# runner — minimal self-contained production server (no source, no dev tooling).
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
