// Compute dominators over strong snapshot edges. Retained size is the dominated
// subtree, not the sum of reachable objects (which double-counts shared objects).
export function summarizeHeap(heap) {
  const meta = heap.snapshot.meta;
  const width = meta.node_fields.length;
  const edgeWidth = meta.edge_fields.length;
  const nodeField = (name) => meta.node_fields.indexOf(name);
  const edgeField = (name) => meta.edge_fields.indexOf(name);
  const nodeTypes = meta.node_types[nodeField("type")];
  const edgeTypes = meta.edge_types[edgeField("type")];
  const count = heap.nodes.length / width;
  const outgoing = Array.from({ length: count }, () => []);
  const incoming = Array.from({ length: count }, () => []);
  let edgeAt = 0;
  for (let from = 0; from < count; from++) {
    const edges = heap.nodes[from * width + nodeField("edge_count")];
    for (let edge = 0; edge < edges; edge++, edgeAt += edgeWidth) {
      if (edgeTypes[heap.edges[edgeAt + edgeField("type")]] === "weak") continue;
      const to = heap.edges[edgeAt + edgeField("to_node")] / width;
      outgoing[from].push(to);
      incoming[to].push(from);
    }
  }
  const seen = new Uint8Array(count);
  const postorder = [];
  const stack = [[0, 0]];
  seen[0] = 1;
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const [node, next] = frame;
    if (next === outgoing[node].length) {
      postorder.push(node);
      stack.pop();
      continue;
    }
    const child = outgoing[node][next];
    frame[1]++;
    if (!seen[child]) {
      seen[child] = 1;
      stack.push([child, 0]);
    }
  }
  const order = postorder.reverse();
  const rank = new Int32Array(count).fill(-1);
  order.forEach((node, index) => {
    rank[node] = index;
  });
  const dominator = new Int32Array(count).fill(-1);
  dominator[0] = 0;
  const intersect = (a, b) => {
    while (a !== b) {
      while (rank[a] > rank[b]) a = dominator[a];
      while (rank[b] > rank[a]) b = dominator[b];
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of order.slice(1)) {
      let parent = -1;
      for (const predecessor of incoming[node]) {
        if (dominator[predecessor] !== -1) parent = parent === -1 ? predecessor : intersect(parent, predecessor);
      }
      if (parent !== dominator[node]) {
        dominator[node] = parent;
        changed = true;
      }
    }
  }
  const retained = new Float64Array(count);
  for (let node = 0; node < count; node++) retained[node] = heap.nodes[node * width + nodeField("self_size")];
  for (let index = order.length - 1; index > 0; index--) retained[dominator[order[index]]] += retained[order[index]];
  const totals = new Map();
  let detachedNodes = 0;
  for (let node = 0; node < count; node++) {
    const at = node * width;
    const type = nodeTypes[heap.nodes[at + nodeField("type")]];
    const name = heap.strings[heap.nodes[at + nodeField("name")]];
    if (nodeField("detachedness") >= 0 && heap.nodes[at + nodeField("detachedness")] === 2 && type === "native") detachedNodes++;
    if (!["object", "closure", "array", "native"].includes(type)) continue;
    const key = `${type}: ${name}`;
    const entry = totals.get(key) ?? { type: key, count: 0, shallowBytes: 0, largestRetainedBytes: 0 };
    entry.count++;
    entry.shallowBytes += heap.nodes[at + nodeField("self_size")];
    entry.largestRetainedBytes = Math.max(entry.largestRetainedBytes, retained[node]);
    totals.set(key, entry);
  }
  return { detachedNodes, largestRetainedTypes: [...totals.values()].sort((a, b) => b.largestRetainedBytes - a.largestRetainedBytes).slice(0, 15) };
}
