export function requestEpisodeEnd(call, path) {
  return call("POST", `${path}/end`, {}).catch(async (error) => {
    if (error.status !== 409 || error.apiCode !== "episode.not_active") throw error;
    const episode = await call("GET", path);
    if (!["ending", "ended"].includes(episode.status)) throw error;
  });
}
