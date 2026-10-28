#!/usr/bin/env bash
set -euo pipefail
export GOTOOLCHAIN=auto
cd "$(dirname "$0")/../../.."
task_dir="$(mktemp -d "$HOME/chalk-tab-crash.XXXXXX")"
export CRASH_TASK_DIR="$task_dir"
children=()
cleanup() {
  for pid in "${children[@]}"; do kill -- "-$pid" 2>/dev/null || true; done
  docker rm -f chalk-tab-crash-pg chalk-tab-crash-redis >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
set -m
uptime
nproc
free -m
pnpm install --frozen-lockfile > "$task_dir/install.log" 2>&1
pnpm --dir sdks/typescript/client exec playwright install --with-deps chromium > "$task_dir/browser-install.log" 2>&1
mkdir -p "$task_dir/published"
printf '{"private":true,"type":"module","pnpm":{"overrides":{"@q9labsai/chalk-client":"5.2.0","@q9labsai/chalk-react":"5.2.0","@q9labsai/chalk-whiteboard":"5.2.0","@q9labsai/chalk-ui":"5.2.0","@q9labsai/facehash":"5.2.0"}}}\n' > "$task_dir/published/package.json"
pnpm --dir "$task_dir/published" --ignore-workspace add --ignore-scripts @q9labsai/chalk-react@5.2.0 @q9labsai/chalk-client@5.2.0 @q9labsai/chalk-whiteboard@5.2.0 react@19.2.7 react-dom@19.2.7 > "$task_dir/published-install.log" 2>&1
docker run -d --name chalk-tab-crash-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=chalk_crash postgres:18 > /dev/null
docker run -d --name chalk-tab-crash-redis -p 6379:6379 redis:7-alpine > /dev/null
export CHALK_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/chalk_crash?sslmode=disable'
for _ in {1..60}; do docker exec chalk-tab-crash-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
bash apps/api/scripts/db-migrate.sh up > "$task_dir/migrations.log" 2>&1
(cd apps/api && GOMAXPROCS=2 go build -o "$task_dir/api" ./cmd) > "$task_dir/api-build.log" 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$task_dir/ca.key" -out "$task_dir/ca.pem" -days 2 -subj '/CN=Crash local CA' > /dev/null 2>&1
for role in api sync; do
  openssl req -new -newkey rsa:2048 -nodes -keyout "$task_dir/$role.key" -out "$task_dir/$role.csr" -subj "/CN=$role" > /dev/null 2>&1
  printf 'subjectAltName=IP:127.0.0.1,URI:spiffe://chalk.local/%s\nextendedKeyUsage=serverAuth,clientAuth\n' "$role" > "$task_dir/$role.ext"
  openssl x509 -req -in "$task_dir/$role.csr" -CA "$task_dir/ca.pem" -CAkey "$task_dir/ca.key" -CAcreateserial -out "$task_dir/$role.pem" -days 2 -extfile "$task_dir/$role.ext" > /dev/null 2>&1
done
node scripts/research/tab-crash/harness.mjs
