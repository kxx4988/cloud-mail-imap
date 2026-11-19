#!/usr/bin/env bash
# [S37] 生成临时自签证书（仅用于 P1 握手验证）
# 正式证书：由 certbot / acme.sh / 面板（如 1Panel）签发后放入 certs/ 目录；
# 本脚本仅生成临时自签证书用于先跑通服务（docs/examples/sync-1panel-cert.sh 为 1Panel 用户的参考实现）。
set -euo pipefail

DOMAIN="${1:-imap.example.com}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$DIR"

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
  -keyout "$DIR/privkey.pem" \
  -out "$DIR/fullchain.pem" \
  -subj "/CN=${DOMAIN}" \
  -addext "subjectAltName=DNS:${DOMAIN}"

# 容器内以非 root（uid 1000）读取，故证书与私钥需 644
chmod 644 "$DIR/fullchain.pem" "$DIR/privkey.pem"

echo "自签证书已生成：$DIR"
openssl x509 -in "$DIR/fullchain.pem" -noout -subject -dates
