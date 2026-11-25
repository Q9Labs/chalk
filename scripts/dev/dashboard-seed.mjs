import { writeDashboardArtifacts } from "./dashboard-artifacts.mjs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { writeJsonAtomic } from "./json-file.mjs";
import { runChecked } from "./chalk-resources.mjs";
import { chalkSfuPlane } from "./config.mjs";

export const dashboardServiceScopes =
  "tenants:read,tenants:write,spaces:read,spaces:write,episodes:read,episodes:write,recordings:read,recordings:write,transcriptions:read,transcriptions:write,transcriptions:delete,focus:read,api_keys:read,api_keys:write,api_keys:delete,webhooks:read,webhooks:write,webhooks:delete";

// Only the local supervisor imports this module; neither deployment entrypoint does.
export function dashboardArtifactBindings(config) {
  return {
    CHALK_RECORDING_ENABLED: "true",
    CHALK_TRANSCRIPTION_ENABLED: "true",
    CHALK_R2_BUCKET: "local-dashboard",
    CHALK_R2_ENDPOINT: `${config.publicOrigin || config.urls.web}/__local-dashboard-artifacts`,
    CHALK_R2_ACCESS_KEY_ID: "local-dashboard",
    CHALK_R2_SECRET_ACCESS_KEY: "local-dashboard-storage-not-a-production-secret",
    CHALK_RECORDING_KMS_KEY_ID: "alias/local-dashboard",
    CHALK_RECORDING_KMS_REGION: "us-east-1",
    CHALK_TRANSCRIPTION_WORKLOAD_AUTH_SECRET: "local-dashboard-transcription-not-a-production-secret",
    CHALK_TRANSCRIPTION_DISPATCHER_FUNCTION_NAME: "local-dashboard",
  };
}

// AI apps sign in to the local MCP server here and consent in the dashboard. Without OAuth the dashboard's
// connected apps list answers 503, so AI apps showed "Couldn't load" on every local stack and Orb.
export function dashboardOAuthBindings(config) {
  return { CHALK_OAUTH_ISSUER: config.urls.api, CHALK_OAUTH_CONSENT_URL: `${config.urls.public}/dashboard/connect` };
}

export async function seedDashboard({ config, serviceToken, systemToken }) {
  async function api(path, body, { method = body ? "POST" : "GET", token = serviceToken, retryMedia = false } = {}) {
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID(), "X-Chalk-Media-Providers": chalkSfuPlane };
    const deadline = Date.now() + 45_000;
    for (;;) {
      const response = await fetch(`${config.urls.api}/v1${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) return response.json();
      if (retryMedia && response.status === 503 && Date.now() < deadline) {
        const problem = await response
          .clone()
          .json()
          .catch(() => null);
        if (problem?.error?.code === "media.unavailable") {
          // A cold build on the same host can briefly close the SFU admission guard.
          console.log("Local dashboard seed: media temporarily unavailable; retrying in 5 seconds");
          await delay(5000);
          continue;
        }
      }
      throw new Error(`Local dashboard seed ${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
  }
  async function sql(statement) {
    await runChecked("docker", ["exec", "-e", "PGOPTIONS=-c chalk.entry_writer=1", config.postgres.container, "psql", "-U", "postgres", "-d", config.databaseName || "chalk_dev", "-v", "ON_ERROR_STOP=1", "-c", statement], { cwd: config.root });
  }
  const owner = await api("/tenants", {
    name: "Ada's workspace",
    external_id: "google:local:fixture_ada",
    cors_allowed_origins: [...new Set([config.urls.web, config.publicOrigin || config.urls.web])],
  });
  const artifacts = {};
  const spaces = await api(`/tenants/${owner.id}/spaces?page_size=100`);
  for (const [index, name] of ["Product planning", "Design review", "Weekly catch-up"].entries()) {
    const slug = `local-dashboard-chalk-sfu-${index}`;
    const space = spaces.spaces.find((item) => item.slug === slug) || (await api(`/tenants/${owner.id}/spaces`, { name, slug, recording_policy: "disabled", transcription_policy: "disabled" }));
    const episodes = await api(`/tenants/${owner.id}/spaces/${space.id}/episodes?page_size=1`);
    let episode = episodes.episodes[0];
    if (!episode || episode.status !== "ended") {
      episode ||= await api(`/tenants/${owner.id}/spaces/${space.id}/episodes`, {}, { retryMedia: true });
      const recordingId = randomUUID();
      const transcriptId = randomUUID();
      const age = index + 1;
      await sql(`begin;
        update episodes set status='ended', started_at=now()-interval '${age} days', ended_at=now()-interval '${age} days'+interval '32 minutes', created_at=now()-interval '${age} days' where id='${episode.id}';
        insert into participants(id,tenant_id,space_id,episode_id,name,capabilities,generation,status,role,joined_at,first_joined_at,left_at)
          select gen_random_uuid(),'${owner.id}','${space.id}','${episode.id}',name,array['subscribe'],1,'left','member',now()-interval '${age} days',now()-interval '${age} days',now()-interval '${age} days'+interval '32 minutes' from unnest(array['Ada Fixture','Maya Chen','Omar Ali']) name;
        ${
          index === 1
            ? ""
            : `insert into recordings(id,tenant_id,space_id,episode_id,status,storage_provider,storage_key,storage_content_type,duration_millis,completed_at,failure_code,failed_at,created_at)
          values('${recordingId}','${owner.id}','${space.id}','${episode.id}','${index === 0 ? "completed" : "failed"}','r2',${index === 0 ? `'tenants/${owner.id}/recordings/preview.wav','audio/wav',12000,now()` : "null,null,null,null"},${index === 0 ? "null,null" : "'recording_failed',now()"},now()-interval '${age} days');`
        }
        ${
          index === 0
            ? `insert into transcriptions(id,tenant_id,space_id,episode_id,recording_id,status,languages,artifact_key,artifact_content_type,completed_at,created_at)
          values('${transcriptId}','${owner.id}','${space.id}','${episode.id}','${recordingId}','complete','{en}','tenants/${owner.id}/recordings/transcript.json','application/json',now(),now()-interval '${age} days');`
            : ""
        }
        commit;`);
    }

    await sql(`insert into episode_focus_intervals(tenant_id,space_id,episode_id,participant_id,state,windowed,started_at,ended_at)
      select e.tenant_id,e.space_id,e.id,p.id,part.state,part.windowed,e.started_at+part.start_offset,e.started_at+part.end_offset
      from episodes e
      join participants p on p.tenant_id=e.tenant_id and p.space_id=e.space_id and p.episode_id=e.id and p.name='Maya Chen'
      join (values
        ('active',false,interval '0 minutes',interval '8 minutes'),
        ('inactive',false,interval '8 minutes',interval '14 minutes'),
        ('active',false,interval '14 minutes',interval '20 minutes'),
        ('background',false,interval '20 minutes',interval '26 minutes'),
        ('active',false,interval '26 minutes',interval '32 minutes')
      ) part(state,windowed,start_offset,end_offset) on true
      where e.id='${episode.id}' and not exists(select 1 from episode_focus_intervals where tenant_id=e.tenant_id and episode_id=e.id);
    insert into episode_focus_step_aways(tenant_id,space_id,episode_id,participant_id,actor_participant_id,reason,started_at,ended_at)
      select e.tenant_id,e.space_id,e.id,p.id,p.id,'reading',e.started_at+interval '9 minutes',e.started_at+interval '12 minutes'
      from episodes e
      join participants p on p.tenant_id=e.tenant_id and p.space_id=e.space_id and p.episode_id=e.id and p.name='Maya Chen'
      where e.id='${episode.id}' and not exists(select 1 from episode_focus_step_aways where tenant_id=e.tenant_id and episode_id=e.id);`);
    if (index === 0) {
      artifacts[`/local-dashboard/tenants/${owner.id}/recordings/transcript.json`] = {
        schemaVersion: "transcript.v1",
        jobId: randomUUID(),
        episodeId: episode.id,
        provider: "cloudflare",
        model: "local-preview",
        versionContract: "v1",
        attempt: 0,
        measuredAudioMs: 12000,
        cues: [
          ["Ada Fixture", "Let's walk through the new onboarding flow and agree on the next steps."],
          ["Maya Chen", "The first screen should make it clear how to start a call. I'll simplify the introduction."],
          ["Omar Ali", "I'll check the API integration. Let's review the changes together on Thursday."],
        ].map(([name, text], cue) => ({
          startMs: cue * 4000,
          endMs: (cue + 1) * 4000,
          identity: { kind: "participant", participantRef: `speaker-${cue}`, participantGeneration: 1, trackId: "audio", trackEpoch: "one" },
          trackClass: "microphone",
          displayNameSnapshot: name,
          text,
          overlap: false,
          provider: "cloudflare",
          model: "local-preview",
          versionContract: "v1",
          attempt: 0,
        })),
      };
      artifacts[`/local-dashboard/tenants/${owner.id}/recordings/preview.wav`] = "preview-audio";
      await sql(
        `update transcriptions set artifact_size=${Buffer.byteLength(JSON.stringify(artifacts[`/local-dashboard/tenants/${owner.id}/recordings/transcript.json`]))} where tenant_id='${owner.id}' and episode_id='${episode.id}' and artifact_key='tenants/${owner.id}/recordings/transcript.json';`,
      );
    }
  }
  const keys = await api(`/tenants/${owner.id}/api-keys?page_size=100`);
  if (!keys.api_keys.some((key) => key.name === "Local development")) await api(`/tenants/${owner.id}/api-keys`, { name: "Local development", scopes: ["spaces:read", "episodes:read"], expires_at: new Date(Date.now() + 90 * 86400000).toISOString() });
  await writeDashboardArtifacts(config.runtimeRoot, artifacts);
  await writeJsonAtomic(`${config.runtimeRoot}/dashboard-artifacts.json`, artifacts, { redacted: false });
}
