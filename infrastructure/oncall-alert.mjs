export function oncallPayload(incidents, { drill }) {
  return { source: "oncall-poller", ...(drill ? { drill: true } : {}), incidents: incidents.map((incident) => ({ app: "chalk", kind: "new", ...incident })) };
}

/** postToOncall sends the incidents to the Oncall webhook. A transport error names no URL, because the URL is a secret. */
export async function postToOncall({ fetchImpl, url, incidents, drill }) {
  let response;
  try {
    response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(oncallPayload(incidents, { drill })) });
  } catch {
    throw new Error("Oncall webhook request failed");
  }
  if (!response.ok) throw new Error(`Oncall webhook answered HTTP ${response.status}`);
}
