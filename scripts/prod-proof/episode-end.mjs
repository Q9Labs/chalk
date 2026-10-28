export async function requestEpisodeEnd(call, path) {
  try {
    await call("POST", `${path}/end`, {});
  } catch (error) {
    if (error.status !== 409 || error.apiCode !== "episode.not_active") throw error;
    const episode = await call("GET", path);
    if (episode.status !== "ending" && episode.status !== "ended") throw error;
  }
}
