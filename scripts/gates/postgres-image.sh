# Sourced by the gate scripts that start PostgreSQL in Docker.
# pull_postgres_image <docker binary> sets postgres_image to a reference that is already pulled. Docker Hub and
# public.ecr.aws each limit anonymous pulls from shared CI addresses on their own, so a rate limit on one registry falls
# through to the other, and the whole list is tried in three rounds. An image that is already local is used as it is, so
# a development machine keeps working when both registries refuse it.
pull_postgres_image() {
  local docker_bin="$1" round candidate
  for candidate in postgres:18.3-alpine public.ecr.aws/docker/library/postgres:18.3-alpine; do
    if "${docker_bin}" image inspect "${candidate}" >/dev/null 2>&1; then
      postgres_image="${candidate}"
      return 0
    fi
  done
  for round in 1 2 3; do
    for candidate in public.ecr.aws/docker/library/postgres:18.3-alpine postgres:18.3-alpine; do
      if "${docker_bin}" pull --quiet "${candidate}" >/dev/null; then
        postgres_image="${candidate}"
        return 0
      fi
    done
    if ((round < 3)); then sleep "$((round * ${POSTGRES_PULL_WAIT_SECONDS:-10}))"; fi
  done
  echo "Could not pull the PostgreSQL image from public.ecr.aws or Docker Hub" >&2
  return 1
}
