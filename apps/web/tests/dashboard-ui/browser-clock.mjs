export async function installClock(tab, clock) {
  if (clock === false) return;
  const skew = clock === true ? 0 : clock;
  const now = Date.now() + skew;
  await tab.clock.install({ time: now });
  await tab.clock.pauseAt(new Date(now + 1000));
}
