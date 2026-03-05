FROM rust:1.85-bookworm AS builder

WORKDIR /app
COPY backend/Cargo.toml backend/Cargo.lock ./backend/
COPY backend/src ./backend/src
COPY backend/data ./backend/data
RUN cargo build --release --manifest-path backend/Cargo.toml

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/backend/target/release/fpsphere-backend /usr/local/bin/fpsphere-backend
COPY backend/data ./data

ENV BIND_ADDR=0.0.0.0:4000
ENV WORLD_DATASTORE_PATH=/app/data/world-repository.json

EXPOSE 4000
CMD ["fpsphere-backend"]
