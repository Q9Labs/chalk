ARG ERLANG_VERSION
FROM erlang:${ERLANG_VERSION}-slim
ARG ELIXIR_VERSION
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates curl unzip git build-essential && rm -rf /var/lib/apt/lists/* \
    && curl --fail --location --retry 3 "https://github.com/elixir-lang/elixir/releases/download/v${ELIXIR_VERSION}/elixir-otp-28.zip" -o /tmp/elixir.zip \
    && unzip -q /tmp/elixir.zip -d /usr/local && rm /tmp/elixir.zip \
    && mix local.hex --force && mix local.rebar --force
ENV MIX_ENV=prod
WORKDIR /workspace/apps/sync
