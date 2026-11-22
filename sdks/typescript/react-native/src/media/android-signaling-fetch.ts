/** Android's fetch polyfill settles completed requests through a JS timer.
 * The single-app capture chooser backgrounds Chalk and pauses those timers,
 * even though the projection service and native networking still run.
 * Settle the SFU's JSON requests directly from the native XHR events.
 */
export const fetchAndroidSignaling: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.text();
  const signal = request.signal;
  if (signal?.aborted) throw abortError(signal);

  return new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => {
      done();
      xhr.abort();
      reject(abortError(signal));
    };
    const done = () => signal?.removeEventListener("abort", abort);

    xhr.open(request.method, request.url);
    if (request.credentials !== "same-origin") xhr.withCredentials = request.credentials === "include";
    request.headers.forEach((value, name) => xhr.setRequestHeader(name, value));
    xhr.onload = () => {
      done();
      try {
        const headers = new Headers();
        for (const line of xhr.getAllResponseHeaders().split(/\r?\n/)) {
          const colon = line.indexOf(":");
          if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
        }
        const responseBody = xhr.status === 204 || xhr.status === 205 || xhr.status === 304 ? null : xhr.responseText;
        resolve(new Response(responseBody, { status: xhr.status, statusText: xhr.statusText, headers }));
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = xhr.ontimeout = () => {
      done();
      reject(new TypeError("Network request failed"));
    };
    xhr.onabort = () => {
      done();
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      xhr.send(body);
    } catch (error) {
      done();
      reject(error);
    }
  });
};

function abortError(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}
