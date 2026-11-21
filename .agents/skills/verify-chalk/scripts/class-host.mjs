#!/usr/bin/env node
// Keeps a class running for a real device: a desktop host starts the call, turns on camera and microphone, shares a moving
// screen and opens the whiteboard, then stays for --minutes. The invite link is written to .verify/<run-id>/link.txt.
//
//   node .agents/skills/verify-chalk/scripts/class-host.mjs <run-id> [--minutes 20] [--web <origin>]
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runJourney } from "./journey.mjs";

const flag = process.argv.indexOf("--minutes");
const minutes = flag > 0 ? Number(process.argv[flag + 1]) : 20;

function fakeScreen() {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext("2d");
  let frame = 0;
  setInterval(() => {
    context.fillStyle = "#102a43";
    context.fillRect(0, 0, 1280, 720);
    context.fillStyle = "white";
    context.font = "72px sans-serif";
    context.fillText(`Shared screen ${frame++}`, 80, 160);
    context.fillRect((frame * 9) % 1100, 300, 160, 160);
  }, 1000 / 15);
  navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(15);
}

await runJourney("class-host", async ({ out, step, person, startCall, control }) => {
  const host = await person("ClassHost", 1);
  await host.context.addInitScript(fakeScreen);
  await step("the host starts the class", async () => {
    const { link } = await startCall(host);
    await writeFile(join(out, "link.txt"), `${link}\n`);
    await control(host, "Unmute microphone");
    await control(host, "Turn on camera");
    await control(host, "Share screen");
    await control(host, "Board");
    console.error(`class link: ${link}`);
  });
  await step(`the class stays open for ${minutes} minutes`, () => host.page.waitForTimeout(minutes * 60_000));
});
