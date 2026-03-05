FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
RUN npm ci

COPY . .
RUN npm run build:shared
RUN npm run build:frontend

FROM nginx:1.27-alpine

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

EXPOSE 4001
CMD ["nginx", "-g", "daemon off;"]
