const AXIOM_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";

export const literal = (value) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/** queryAxiom runs one APL query and returns the tabular body. An error names no token. */
export async function queryAxiom({ fetchImpl, token, apl, startTime, endTime }) {
  let response;
  try {
    response = await fetchImpl(AXIOM_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ apl, startTime, endTime }),
    });
  } catch {
    throw new Error("Axiom query request failed");
  }
  if (!response.ok) throw new Error(`Axiom query answered HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("Axiom returned invalid JSON");
  }
}
