# --- build stage ---
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY . .
RUN cargo build --release -p greehvacd

# --- runtime stage ---
# RustCrypto is pure Rust and musl links statically, so the binary needs nothing
# from the base image but a place to sit.
FROM alpine:3 AS runtime
COPY --from=build /src/target/release/greehvacd /usr/local/bin/greehvacd
EXPOSE 8481
# GREE uses UDP on the LAN (scan/bind/poll). Run this container with host
# networking (--network host / network_mode: host) so UDP reaches the AC.
ENTRYPOINT ["/usr/local/bin/greehvacd"]
