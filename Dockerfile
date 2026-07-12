FROM golang:1.26-alpine AS web-builder
WORKDIR /build
COPY go.mod ./
COPY main.go index.html ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/server ./main.go

FROM alpine:latest
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=web-builder /out/server ./server
COPY index.html ./index.html
RUN chmod +x ./server
EXPOSE 8096
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O- http://localhost:8096/healthz || exit 1
CMD ["./server"]
