import { readdir, stat } from "node:fs/promises";
import { relative } from "node:path";
import { FailureKind, failure } from "./model.mjs";

const ignored = new Set([".git", "node_modules", "_build", "deps", "dist", "tmp", ".elixir_ls"]);

export function dependencyOrder(specs = []) {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const result = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw failure(FailureKind.CONFIG, `service dependency cycle at ${id}`, { stage: "startup" });
    const spec = byId.get(id);
    if (!spec) throw failure(FailureKind.CONFIG, `unknown service dependency: ${id}`, { stage: "startup" });
    visiting.add(id);
    for (const dependency of spec.dependsOn || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    result.push(spec);
  };
  for (const spec of specs) visit(spec.id);
  return result;
}

export function dependantIds(specs, serviceId) {
  const reverse = new Map(specs.map((spec) => [spec.id, []]));
  for (const spec of specs) for (const dependency of spec.dependsOn || []) reverse.get(dependency)?.push(spec.id);
  const result = [];
  const seen = new Set();
  const visit = (id) => {
    for (const dependant of reverse.get(id) || []) {
      if (seen.has(dependant)) continue;
      seen.add(dependant);
      result.push(dependant);
      visit(dependant);
    }
  };
  visit(serviceId);
  return result;
}

async function scanFiles(roots, { fs = { readdir, stat } } = {}) {
  const files = new Map();
  const visit = async (root) => {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const path = `${root}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const metadata = await fs.stat(path);
        files.set(path, `${metadata.mtimeMs}:${metadata.size}`);
      }
    }
  };
  for (const root of roots) await visit(root);
  return files;
}

export function createSourcePoller({ rootsByService, intervalMs = 250, debounceMs = 350, onChange, scanner = scanFiles } = {}) {
  if (typeof onChange !== "function") throw failure(FailureKind.CONFIG, "source poller requires onChange", { stage: "reload" });
  const serviceRoots = Object.entries(rootsByService || {});
  let snapshots = new Map();
  const initialized = new Set();
  let timer;
  let debounce;
  let closed = false;

  const poll = async () => {
    if (closed) return;
    const changes = [];
    for (const [serviceId, roots] of serviceRoots) {
      const next = await scanner(roots);
      if (!initialized.has(serviceId)) {
        snapshots.set(serviceId, next);
        initialized.add(serviceId);
        continue;
      }
      const previous = snapshots.get(serviceId) || new Map();
      for (const path of new Set([...previous.keys(), ...next.keys()])) {
        if (previous.get(path) !== next.get(path)) changes.push({ serviceId, path, relativePath: relative(roots[0] || "", path) });
      }
      snapshots.set(serviceId, next);
    }
    if (changes.length > 0) {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (!closed) void onChange(changes);
      }, debounceMs);
    }
    if (!closed) timer = setTimeout(() => void poll(), intervalMs);
  };
  void poll();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      clearTimeout(debounce);
    },
    async flush() {
      await poll();
    },
  };
}

export function createReloadCoordinator({ serviceSpecs, restart, onState = () => {} } = {}) {
  const ordered = dependencyOrder(serviceSpecs || []);
  let queue = Promise.resolve();
  const request = (changes) => {
    const ids = [...new Set((changes || []).map((change) => change.serviceId || change))];
    queue = queue.then(async () => {
      if (ids.length === 0) return;
      const affected = new Set(ids);
      for (const id of ids) for (const dependant of dependantIds(ordered, id)) affected.add(dependant);
      const stopping = [...ordered].reverse().filter((spec) => affected.has(spec.id));
      const starting = ordered.filter((spec) => affected.has(spec.id));
      onState({ state: "reloading", services: [...affected] });
      try {
        for (const spec of stopping) await restart(spec.id, "stop");
        for (const spec of starting) await restart(spec.id, "start");
        onState({ state: "ready", services: [...affected] });
      } catch (error) {
        onState({ state: "reload-failed", services: [...affected], error });
        throw error;
      }
    });
    return queue;
  };
  return { request };
}
