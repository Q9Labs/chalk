# Run Chalk locally

Use this guide for web, SDK, Go API, Sync, and Android work. Windows uses PowerShell. WSL is not required.

## Install the tools

Every OS needs Git, Node.js, pnpm, and a running Docker-compatible engine. Use Node.js 24.21.0 from `.tool-versions` and pnpm 12.8.1 from `package.json`. API and Sync toolchains live in the dev images. You do not need host Go, Erlang, Elixir, or OpenSSL to run the stack.

### macOS

Install [Homebrew](https://brew.sh), then run:

```sh
brew install git node@24
brew install --cask orbstack
brew link --force node@24
npm install --global pnpm@12.8.1
open -a OrbStack
```

Homebrew supplies the current Node.js 24 patch. To use the exact repository pin, install Node.js 24.21.0 from the [Node.js download archive](https://nodejs.org/dist/v24.21.0/).

### Linux

On Ubuntu, install Git and the tools needed to download Node.js:

```sh
sudo apt update
sudo apt install --yes git curl ca-certificates xz-utils
```

Install Docker Engine from [Docker's Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/). After adding Docker's apt repository, install its packages:

```sh
sudo apt install --yes docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Sign out and back in after changing the group. Use the [Node.js downloads](https://nodejs.org/en/download) for Node.js 24.21.0 and your CPU architecture. Then install pnpm:

```sh
npm install --global pnpm@12.8.1
```

### Windows

Install Git, Node.js, and Docker Desktop with winget:

```powershell
winget install --exact --id Git.Git
winget install --exact --id OpenJS.NodeJS.LTS --version 24.21.0
winget install --exact --id Docker.DockerDesktop
```

Start Docker Desktop and select Linux containers. Docker Desktop may use its WSL 2 backend internally. You do not need a WSL distribution or a WSL shell. Reopen PowerShell after installing the tools, then run:

```powershell
npm install --global pnpm@12.8.1
```

If PowerShell blocks an npm script shim, use `npm.cmd` or `pnpm.cmd`. Chalk resolves Windows command shims when it starts child tools.

## Clone and configure Git

Keep LF line endings. Run these commands before cloning on any OS:

```sh
git config --global core.autocrlf false
git config --global core.longpaths true
git clone https://github.com/Q9Labs/chalk.git
cd chalk
pnpm install --frozen-lockfile
pnpm hooks:install
```

The repository attributes keep text files as LF. `core.longpaths` helps Windows check out nested package paths. Keep the checkout outside OneDrive and other synced folders.

## Start the stack

Check the Docker engine, then start Chalk:

```sh
docker info
pnpm dev:status
pnpm dev
```

Wait for `Chalk dev ready`. The first run downloads images and dependencies and compiles API and Sync. Later starts reuse named caches. Open the printed web URL, normally `http://127.0.0.1:3070`.

The core profile starts Postgres, Redis, API, and Sync containers. SDK watchers and the web server run on the host. Source changes reload the affected services. Go module/build caches and Mix `deps`/`_build` stay in named Docker volumes. Host builds never share those outputs.

All default host listeners are loopback-only. The API reads dashboard artifacts from a dedicated read-only mount, served only inside its container. It does not connect to the host web server. Setting `PUBLIC_ORIGIN` explicitly opts the web dev server into listening on all interfaces for a reverse proxy or Orb. That exposes the passwordless fixture dashboard to reachable peers; use this only in an isolated development environment.

For calls from another machine, set `CHALK_DEV_SFU_ANNOUNCE_IP` to the dev host's reachable IPv4 address in addition to setting the HTTPS `PUBLIC_ORIGIN`. This publishes only the SFU media port on all IPv4 interfaces, over UDP and TCP. Allow that port (`CHALK_DEV_SFU_MEDIA_PORT`, default `50000`) through the firewall to the test clients, and forward it unchanged if using NAT. The HTTPS proxy does not carry WebRTC media. Leave the announce address unset for same-machine browsers and Orbs that expose only the web origin.

Backend edits keep the web server running. Sync fetches dependencies at startup and when `apps/sync/mix.exs` or `apps/sync/mix.lock` changes. Source-only edits compile incrementally.

Choose a profile when needed:

```sh
pnpm dev --profile core
pnpm dev --profile android
pnpm dev --profile mobile
```

`android` and `mobile` add Metro and require Java and adb. Install Android Studio, Android SDK platform tools, and the SDK versions requested by `apps/mobile/android`. Add platform tools to PATH and set `ANDROID_HOME`. Use Java 17. Open an emulator in Android Studio or connect a debug-enabled device. `ios` is a macOS-only profile and requires Xcode and `xcrun`.

Only one Chalk runtime can own a machine. `pnpm dev:status` names its checkout. Stop that runtime from its own checkout before starting another.

Useful commands:

```sh
pnpm dev:doctor
pnpm dev:smoke
pnpm dev:logs api
pnpm dev:stop
pnpm dev:down
```

For media smoke, install the test browser once with `pnpm exec playwright install chromium`. On Linux, use `pnpm exec playwright install --with-deps chromium` to include system libraries.

`doctor` checks the running stack and a seeded guest's join. `smoke` checks the media path. `stop` stops the runtime and its containers but keeps data and caches. `down` also removes the local runtime files, resets the dev database, and removes the dev Redis volume. It keeps Postgres storage, build caches, logs, and verification evidence. `pnpm dev --fresh` recreates this checkout's seeded Tenant and Space.

Logs are in `.logs/dev-server.log`. Windows ownership files live in `%LOCALAPPDATA%\chalk`. macOS uses `~/Library/Application Support/chalk`. Linux uses `$XDG_STATE_HOME/chalk`, or `~/.local/state/chalk`.

## Run API and Sync tests

Use the same dev toolchains on every OS, including Windows:

```sh
pnpm dev:exec api go test ./...
pnpm dev:exec sync mix test
```

Start the stack first. The command mounts the checkout and the named language caches. Sync tests use `MIX_ENV=test`. Each command creates and migrates a separate temporary test database, then removes it. It never uses the dev database. Set `CHALK_DATABASE_URL` only to use a test database you manage yourself. See the [database workflow](../apps/api/docs/database-workflow.md) and [Sync README](../apps/sync/README.md) for test database setup and test groups.

To run migrations in the API container:

```sh
node apps/api/scripts/db-migrate.mjs status
```

## Check and submit a change

The commit hook runs `pnpm gate:fast` on staged files. Run the selected checks before opening a PR:

```sh
pnpm gate
```

Run `pnpm regen` after changing generator inputs, then run `pnpm check:generated`. Go and Sync checks use their pinned tools. Read [gate operations](../scripts/gates/README.md) for the full Linux gate and database checks.

Open one draft PR for the related change. Drafts skip the main Gate, Mobile CI, and Release contracts. Finish local checks and self-review before marking it ready. Mark it ready once and batch fixes into one push. Each push to a ready PR reruns the Gate. Follow [CODING_STANDARDS.md](../CODING_STANDARDS.md).

Orbs and Instabox are Q9-internal tools. Outside engineers rely on GitHub CI and ask a Q9 member or agent for an Orb when a change needs product UI proof. Do not put private credentials, production identifiers, or raw debug evidence in this public repository.
