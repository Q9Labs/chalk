import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const logs = mkdtempSync(path.join(tmpdir(), "chalk-mutations-"));
const go = (name) => ({ cwd: "apps/api", command: ["go", "test", "-count=1", "-v", "-vet=off", `./internal/${name}`] });
const vitest = (workspace, file) => ({ command: ["node", "scripts/test/run.mjs", "pnpm", "--dir", workspace, "exec", "vitest", "run", file, "--maxWorkers=1"] });
const mix = (file) => ({ cwd: "apps/sync", command: ["mix", "test", file, "--max-cases", "1"] });
const cases = [
  {
    name: "media-credential-signature",
    file: "apps/api/internal/accessgrants/verifier.go",
    from: '!ed25519.Verify(publicKey, []byte(parts[0]+"."+parts[1]), signature)',
    to: 'ed25519.Verify(publicKey, []byte(parts[0]+"."+parts[1]), signature)',
    ...go("accessgrants"),
  },
  {
    name: "sync-credential-authentication",
    file: "apps/api/internal/synctokens/verifier.go",
    from: '!ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), signature)',
    to: 'len(key) == 0 && !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), signature)',
    ...go("synctokens"),
  },
  {
    name: "purge-byte-drift",
    file: "apps/api/internal/tenantpurge/objects.go",
    from: "facts.Size != object.Size || strings.Trim",
    to: "facts.Size != object.Size && strings.Trim",
    ...go("tenantpurge"),
  },
  {
    name: "purge-overlapping-partitions",
    file: "apps/api/internal/tenantpurge/plan.go",
    from: 'identity.Name == "" || seen[identity.ID]',
    to: 'identity.Name == "" && seen[identity.ID]',
    ...go("tenantpurge"),
  },
  {
    name: "episode-end-fence-error",
    file: "apps/api/internal/adapters/postgres/episode_control.go",
    from: "err == nil || errors.Is(err, pgx.ErrNoRows)",
    to: "err == nil && errors.Is(err, pgx.ErrNoRows)",
    ...go("adapters/postgres"),
  },
  {
    name: "vp8-picture-continuity",
    file: "apps/api/internal/recordingdecode/vp8_picture.go",
    from: "(id.value-previous.value)&id.mask == 1",
    to: "(id.value-previous.value)&id.mask == 2",
    ...go("recordingdecode"),
  },
  {
    name: "whiteboard-revoked-participant",
    file: "apps/sync/lib/chalk_sync/whiteboard_v1/authority.ex",
    from: '{_episode, "left"} -> {:error, {:permission_denied, :participant_inactive}}',
    to: '{_episode, "joining"} -> {:error, {:permission_denied, :participant_inactive}}',
    ...mix("test/chalk_sync/whiteboard_v1/authority_test.exs"),
  },
  {
    name: "ended-reconnect-terminal-state",
    file: "apps/sync/lib/chalk_sync/stateholder/postgres/recovery_reader.ex",
    from: 'defp recovery_mode("ended", _active_mode), do: :terminal',
    to: 'defp recovery_mode("ended", active_mode), do: active_mode',
    ...mix("test/chalk_sync/transport/ended_reconnect_postgres_test.exs:50"),
  },
  {
    name: "provider-bridge-readiness",
    file: "apps/sync/lib/chalk_sync/operations/probe.ex",
    from: "{:error, _reason} -> {:error, :provider_bridge_unavailable}",
    to: '{:error, _reason} -> {:ok, %{status: "ready"}}',
    command: ["apps/sync/scripts/provider-bridge-readiness-test"],
  },
  {
    name: "webhook-authentication",
    file: "sdks/typescript/client/src/webhooks/verify.ts",
    from: 'if (!matched) throw new WebhookVerificationError("invalid_signature");',
    to: 'if (matched && false) throw new WebhookVerificationError("invalid_signature");',
    ...vitest("sdks/typescript/client", "src/webhooks/verify.test.ts"),
  },
  {
    name: "sync-admission-order",
    file: "sdks/typescript/client/src/sync/v1-reducer.ts",
    from: "admission_requests: state.admissionRequests.map((request)",
    to: "admission_requests: [...state.admissionRequests].reverse().map((request)",
    ...vitest("sdks/typescript/client", "src/sync/v1-admission-order.test.ts"),
  },
  {
    name: "episode-ending-wins-provider-rejection",
    file: "sdks/typescript/client/src/connection/lifecycle.ts",
    from: 'return status === "ending" || status === "ended";',
    to: 'return status === "ended";',
    ...vitest("sdks/typescript/client", "src/connection/episode-end-race.test.ts"),
  },
  {
    name: "dashboard-session-expiry",
    file: "apps/web/server/session.ts",
    from: "identity.expiresAt <= Date.now()",
    to: "identity.expiresAt <= 0",
    ...vitest("apps/web", "server/session.test.ts"),
  },
  {
    name: "owner-seat-supersession-recovery",
    file: "apps/web/server/owner-access.ts",
    from: "payload: { participant_generation: seat.generation, replace_media_connection: true },",
    to: "payload: { participant_generation: seat.generation, replace_media_connection: false },",
    ...vitest("apps/web", "server/owner-access.test.ts"),
  },
  {
    name: "transcription-terminal-failure",
    file: "apps/transcription-dispatcher/src/finalizer.ts",
    from: 'const terminal = kind === "nonretryable" || kind === "schema";',
    to: 'const terminal = kind === "nonretryable";',
    ...vitest("apps/transcription-dispatcher", "test/finalizer.test.ts"),
  },
  {
    name: "whiteboard-code-unit-order",
    file: "packages/whiteboard/src/collab/order.ts",
    from: "return left < right ? -1 : 1;",
    to: "return left.localeCompare(right);",
    ...vitest("packages/whiteboard", "src/collab/reducer.test.ts"),
  },
  {
    name: "test-loopback-isolation",
    file: "scripts/test/no-network.mjs",
    from: 'new Set(["localhost", "::1"])',
    to: 'new Set(["::1"])',
    command: ["node", "--test", "scripts/test/no-network.test.mjs"],
  },
];

const baselines = new Set();
let killed = 0;
for (const mutation of cases) {
  try {
    const filename = path.join(root, mutation.file);
    const cwd = path.join(root, mutation.cwd ?? ".");
    const original = readFileSync(filename, "utf8");
    if (original.split(mutation.from).length !== 2) throw new Error(`${mutation.name}: mutation must match exactly once`);
    const run = (kind) => {
      const result = spawnSync(mutation.command[0], mutation.command.slice(1), {
        cwd,
        encoding: "utf8",
        timeout: 240_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GOMAXPROCS: "1", VITEST_MAX_WORKERS: "1", ERL_FLAGS: "+S 1:1", MIX_ENV: "test", GOFLAGS: "-buildvcs=false" },
      });
      const output = [result.stdout, result.stderr].join("\n");
      const log = path.join(logs, `${mutation.name}-${kind}.log`);
      writeFileSync(log, output);
      if (result.error || result.signal || /build failed|syntax error|undefined:|Cannot find module|No test files found|Compilation error|--- SKIP:/i.test(output)) throw new Error(`${mutation.name}: invalid ${kind} run; see ${log}`);
      return { ...result, output, log };
    };
    const key = JSON.stringify([mutation.cwd, mutation.command]);
    if (!baselines.has(key)) {
      const baseline = run("baseline");
      if (baseline.status !== 0 || /[1-9]\d* (?:skipped|invalid)/.test(baseline.output)) throw new Error(`${mutation.name}: baseline failed; see ${baseline.log}`);
      baselines.add(key);
    }
    try {
      writeFileSync(filename, original.replace(mutation.from, mutation.to));
      const result = run("mutant");
      if (result.status === 0 || !/--- FAIL:|AssertionError|\bassert\b|assertion|Expected/i.test(result.output)) throw new Error(`${mutation.name}: not killed by a behavioral assertion; see ${result.log}`);
      console.log(`KILLED ${mutation.name}`);
    } finally {
      writeFileSync(filename, original);
    }
    killed += 1;
  } catch (error) {
    console.error(error);
  }
}
console.log(`Mutation proof: ${killed}/${cases.length} killed; logs: ${logs}`);
if (killed !== cases.length) process.exitCode = 1;
