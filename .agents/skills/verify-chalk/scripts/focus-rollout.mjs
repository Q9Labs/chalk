#!/usr/bin/env node
// Proof for the Promote of Focus: the previous release (API and Sync) against a database migrated to master.
// An owner starts a call before the migration, leaves, the master migrations run, and the owner rejoins and uses an owner control.
//
//   node .agents/skills/verify-chalk/scripts/focus-rollout.mjs <run-id>
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { runJourney } from "./journey.mjs";

const psql = (sql) => execFileSync("docker", ["exec", "-i", "chalk-postgres", "psql", "-U", "postgres", "-d", "chalk_dev", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], { encoding: "utf8" }).trim();
const psqlFile = (text) => execFileSync("docker", ["exec", "-i", "chalk-postgres", "psql", "-U", "postgres", "-d", "chalk_dev", "-v", "ON_ERROR_STOP=1", "-1", "-q"], { input: text, encoding: "utf8" });
const ownerCaps = () => psql("select string_agg(distinct c, ',' order by c) filter (where c like 'focus.%') from space_roles, unnest(capabilities) c where name = 'owner'");
const migrationDir = ".proof/migrations";

await runJourney("focus-rollout", async ({ step, person, startCall, joinByLink, control, shot, out }) => {
  const owner = await person("RolloutOwner", 1);
  const guest = await person("RolloutGuest", 2);
  const tile = (who, name) => who.page.getByRole("button", { name: `Video tile for ${name}`, exact: true });
  let call;

  await step("before the migration: the owner starts a call and the guest joins", async () => {
    call = await startCall(owner);
    await joinByLink(guest, call.link);
    await tile(owner, guest.name).waitFor({ timeout: 60_000 });
    return { goose: psql("select max(version_id) from goose_db_version where is_applied"), focusCapsOnOwnerRoles: ownerCaps() };
  });

  await step("the owner leaves", async () => {
    await control(owner, "Leave call");
    await owner.page.getByRole("menuitem", { name: "Leave call", exact: true }).click();
    await owner.page.getByRole("button", { name: "Rejoin", exact: true }).waitFor({ timeout: 30_000 });
  });

  await step("the master migrations run against the database the previous release is using", async () => {
    const files = readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort();
    for (const file of files) {
      const text = readFileSync(`${migrationDir}/${file}`, "utf8");
      const up = text.split("-- +goose Down")[0].replace("-- +goose Up", "");
      psqlFile(up);
      psql(`insert into goose_db_version (version_id, is_applied) values (${file.split("_")[0]}, true)`);
    }
    const caps = ownerCaps();
    if (!caps) throw new Error("the migration did not give any owner role a focus capability");
    return { files, goose: psql("select max(version_id) from goose_db_version where is_applied"), focusCapsOnOwnerRoles: caps };
  });

  await step("after the migration: the owner rejoins on the previous release", async () => {
    await owner.page.getByRole("button", { name: "Rejoin", exact: true }).click();
    await tile(owner, owner.name).waitFor({ timeout: 60_000 });
    await tile(guest, owner.name).waitFor({ timeout: 60_000 });
    await shot(owner, "rejoined-after-migration");
  });

  await step("the owner uses an owner control: End call for everyone", async () => {
    await control(owner, "Leave call");
    await owner.page.getByRole("menuitem", { name: "End call for everyone", exact: true }).click();
    for (const who of [owner, guest]) await who.page.getByRole("heading", { name: "The call ended", exact: true }).waitFor({ timeout: 30_000 });
    await shot(guest, "ended-after-migration");
  });
});
