// @ts-check
// Chain hop b: builds positive.json and healthy.json from the committed chain rows and re-judges them.
// CHALK_CHAIN_WRITE=1 rewrites the fixtures from the chain files.
import test from "node:test";
import { runChain } from "./harness.mjs";

const code = process.env.CHALK_CHECK;
const codes = code ? [code] : ["admission.unresolved", "invite.refused", "boot.app_failed", "boot.never_ran", "prejoin.devices_blocked", "prejoin.preview_failed", "dashboard.request_failed", "embed.blocked", "admission.unanswered", "admission.not_collected"];
for (const c of codes) test(`${c} chain fixtures`, () => runChain(c));
