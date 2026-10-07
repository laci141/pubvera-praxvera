FROM golang:1.26-alpine AS web-builder
WORKDIR /build
COPY go.mod ./
COPY main.go index.html ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/server ./main.go

FROM alpine:3.24
RUN apk add --no-cache ca-certificates
RUN addgroup -S app && adduser -S -G app app
WORKDIR /app
COPY --from=web-builder /out/server ./server
COPY index.html ./index.html
RUN chmod +x ./server
USER app
EXPOSE 8096
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 CMD wget -q -O- http://localhost:8096/healthz || exit 1
CMD ["./server"]
