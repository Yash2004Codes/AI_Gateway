#!/usr/bin/env bash
# Ship the committed code (git HEAD) to the EC2 host and (re)start the stack.
# Safe to re-run: it rebuilds and restarts; data volumes are kept.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
source deploy/.state
DOMAIN="${PUBLIC_IP//./-}.sslip.io"
SSH="ssh -i $KEY_FILE -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 ec2-user@$PUBLIC_IP"
SCP="scp -i $KEY_FILE -o StrictHostKeyChecking=accept-new"

# ── Secrets: generated once, kept locally in .env.prod (gitignored) ──
if [ ! -f .env.prod ]; then
  rand() { node -e "console.log(require('crypto').randomBytes($1).toString('base64url'))"; }
  cat > .env.prod <<EOF
DOMAIN=$DOMAIN
POSTGRES_USER=gateway
POSTGRES_PASSWORD=$(rand 24)
POSTGRES_DB=ai_gateway
JWT_SECRET=$(rand 48)
ADMIN_PASSWORD=$(rand 12)
# Public demo: simulate every vendor so visitors can't spend real money
LLM_MOCK_MODE=true
DEMO_MODE=true
EOF
  echo "Created .env.prod with fresh secrets."
fi
# shellcheck disable=SC1091
source .env.prod

echo "==> Waiting for the host to finish first-boot setup"
until $SSH 'test -f /var/local/bootstrap-done' 2>/dev/null; do sleep 5; done

echo "==> Uploading $(git rev-parse --short HEAD)"
git archive --format=tar.gz -o deploy/.release.tar.gz HEAD
$SCP deploy/.release.tar.gz .env.prod "ec2-user@$PUBLIC_IP:/tmp/"
rm -f deploy/.release.tar.gz
$SSH 'mkdir -p ~/ai-gateway && tar -xzf /tmp/.release.tar.gz -C ~/ai-gateway \
  && mv /tmp/.env.prod ~/ai-gateway/.env.prod && chmod 600 ~/ai-gateway/.env.prod && rm /tmp/.release.tar.gz'

echo "==> Building and starting (first build takes a few minutes)"
COMPOSE='docker compose -f docker-compose.prod.yml --env-file .env.prod'
$SSH "cd ~/ai-gateway && $COMPOSE up -d --build --remove-orphans"

echo "==> Waiting for https://$DOMAIN (certificate + API health)"
for i in $(seq 1 60); do
  curl -sS "https://$DOMAIN/api/v1/admin/live" -o /dev/null -w '%{http_code}' 2>/dev/null | grep -q 401 && break
  [ "$i" = 60 ] && { echo "Timed out. Check: $SSH 'cd ~/ai-gateway && $COMPOSE logs --tail 50'"; exit 1; }
  sleep 5
done

echo "==> Setting the admin password from .env.prod"
HASH=$(node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" "$ADMIN_PASSWORD")
printf "UPDATE users SET password_hash = '%s' WHERE email = 'admin@gateway.local';\n" "$HASH" \
  | $SSH "cd ~/ai-gateway && $COMPOSE exec -T postgres psql -q -U $POSTGRES_USER -d $POSTGRES_DB"

echo "==> Seeding 24h of demo history"
TOKEN=$(curl -fsS -X POST "https://$DOMAIN/api/v1/admin/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@gateway.local\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).token")
curl -fsS -X POST "https://$DOMAIN/api/v1/admin/demo/seed-history" -H "Authorization: Bearer $TOKEN"
echo

echo
echo "Live at https://$DOMAIN"
echo "Login: admin@gateway.local / (ADMIN_PASSWORD in .env.prod)"
