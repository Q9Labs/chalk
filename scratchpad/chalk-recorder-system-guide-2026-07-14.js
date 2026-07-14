(() => {
  const definitions = new Map(
    [
      ["authority envelope", "The short-lived collection of permissions needed for one job attempt."],
      ["object intent", "A one-operation storage grant whose exact path and limits were chosen by the server."],
      ["graphics worker", "The graphics-enabled machine that replays the recorded timeline and builds the final outputs."],
      ["capture worker", "The native process that receives selected live tracks and writes encrypted media pieces."],
      ["control service", "The Chalk service and background loops that make durable decisions without carrying media."],
      ["transcription", "Turning recorded speech into timed text after the video pipeline hands off bounded audio chunks."],
      ["finalization", "The one database transaction that commits the video and complete transcript handoff."],
      ["qualification", "The real staging proof of workload limits, failures, cleanup, observability, cost, and deadlines."],
      ["reconciliation", "Comparing intended state with provider, worker, and storage reality, then applying safe corrections."],
      ["reconciler", "The control loop that performs reconciliation."],
      ["immutable", "Written once and never silently replaced with different facts."],
      ["Cloudflare", "The provider that relays Chalk's live participant media and stores encrypted recorder objects."],
      ["RealtimeKit", "Cloudflare's higher-level meeting product; this recorder uses the lower-level direct media relay."],
      ["GStreamer", "A media pipeline framework used to compose changing tracks and graphics."],
      ["FFmpeg", "A media toolkit used here as an independent checker of the final file, codecs, and timing."],
      ["keyframe", "A complete video frame that lets a decoder restart without earlier frames."],
      ["certificate", "A short-lived signed identity proving which machine and role is speaking."],
      ["lease", "Temporary permission for one worker to execute one job attempt."],
      ["fence", "An increasing generation number that makes every replaced attempt stale."],
      ["schema", "A machine-readable description of the exact fields and validation rules in a message."],
      ["transaction", "A group of database changes that either all commit together or none do."],
      ["provider", "An external service Chalk depends on, such as Cloudflare or a machine host."],
      ["retention", "How long temporary inputs remain available before mandatory deletion."],
    ].sort((left, right) => right[0].length - left[0].length),
  );

  const expression = new RegExp(`\\b(${[...definitions.keys()].map((term) => term.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")).join("|")})\\b`, "gi");
  const excluded = "script, style, select, option, button, output, code, a, .term";

  function definitionFor(value) {
    const normalized = value.toLocaleLowerCase();
    for (const [term, definition] of definitions) {
      if (term.toLocaleLowerCase() === normalized) return definition;
    }
    return "";
  }

  function decorate(root = document.body) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach((node) => {
      const parent = node.parentElement;
      if (!parent || parent.closest(excluded) || !expression.test(node.data)) {
        expression.lastIndex = 0;
        return;
      }
      expression.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const match of node.data.matchAll(expression)) {
        fragment.append(node.data.slice(cursor, match.index));
        const term = document.createElement("span");
        term.className = "term";
        term.tabIndex = 0;
        term.dataset.def = definitionFor(match[0]);
        term.textContent = match[0];
        fragment.append(term);
        cursor = match.index + match[0].length;
      }
      fragment.append(node.data.slice(cursor));
      node.replaceWith(fragment);
    });
  }

  window.decorateRecorderTerms = decorate;
  decorate();
})();
