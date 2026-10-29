FROM golang:1.27-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS web-builder
WORKDIR /build
COPY go.mod ./
COPY main.go version.go csp.go index.html ./
# The CalVer version from the release workflow; "dev" for any other build.
# -X names the variable main.appVersion: for package main the linker uses
# "main", not the module path. The target is the package (.), not ./main.go:
# a single-file build would leave out version.go.
ARG APP_VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-X main.appVersion=${APP_VERSION}" -o /out/server .

FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache ca-certificates
RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
WORKDIR /app
COPY --from=web-builder /out/server ./server
COPY index.html ./index.html
RUN chmod +x ./server
# The CalVer version the server reports on /version.
ARG APP_VERSION=dev
LABEL org.opencontainers.image.version=${APP_VERSION}
USER app
EXPOSE 8096
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 CMD wget -q -O- http://localhost:8096/healthz || exit 1
CMD ["./server"]
