(() => {
  const refs = { tracks: [], peers: [], canvases: [], offscreens: [], workers: [], sockets: [] };
  const totals = Object.fromEntries(Object.keys(refs).map(key => [key, 0]));
  function record(key, object) { refs[key].push(new WeakRef(object)); totals[key]++; return object; }
  function wrap(name, key) {
    if (!window[name]) return;
    window[name] = new Proxy(window[name], { construct(Target, args) { return record(key, Reflect.construct(Target, args)); } });
  }
  wrap('RTCPeerConnection', 'peers'); wrap('Worker', 'workers'); wrap('SharedWorker', 'workers');
  wrap('OffscreenCanvas', 'offscreens'); wrap('WebSocket', 'sockets');
  const stoppedWorkers = new WeakSet();
  const terminate = Worker.prototype.terminate;
  Worker.prototype.terminate = function() { stoppedWorkers.add(this); return terminate.call(this); };
  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function(...args) {
    const element = createElement.apply(this, args);
    if (element instanceof HTMLCanvasElement) record('canvases', element);
    return element;
  };
  for (const method of ['getUserMedia', 'getDisplayMedia']) {
    const original = navigator.mediaDevices[method]?.bind(navigator.mediaDevices);
    if (original) navigator.mediaDevices[method] = async (...args) => {
      const stream = await original(...args);
      stream.getTracks().forEach(track => record('tracks', track));
      return stream;
    };
  }
  const clone = MediaStreamTrack.prototype.clone;
  MediaStreamTrack.prototype.clone = function() { return record('tracks', clone.call(this)); };
  const timers = new Map();
  const timeout = window.setTimeout.bind(window), interval = window.setInterval.bind(window);
  const clearTimeoutOriginal = window.clearTimeout.bind(window), clearIntervalOriginal = window.clearInterval.bind(window);
  window.setTimeout = (callback, delay, ...args) => {
    const id = timeout(() => { timers.delete(id); typeof callback === 'function' ? callback(...args) : (0, eval)(callback); }, delay);
    timers.set(id, { kind: 'timeout', delay }); return id;
  };
  window.setInterval = (callback, delay, ...args) => { const id = interval(callback, delay, ...args); timers.set(id, { kind: 'interval', delay }); return id; };
  window.clearTimeout = id => { timers.delete(id); clearTimeoutOriginal(id); };
  window.clearInterval = id => { timers.delete(id); clearIntervalOriginal(id); };
  window.__resources = () => {
    const live = {};
    for (const key of Object.keys(refs)) {
      const objects = refs[key].map(ref => ref.deref()).filter(Boolean);
      refs[key] = objects.map(object => new WeakRef(object));
      live[key] = objects.length;
      if (key === 'tracks') live.activeTracks = objects.filter(track => track.readyState === 'live').length;
      if (key === 'peers') live.openPeers = objects.filter(peer => peer.signalingState !== 'closed').length;
      if (key === 'workers') live.activeWorkers = objects.filter(worker => !stoppedWorkers.has(worker)).length;
      if (key === 'sockets') live.openSockets = objects.filter(socket => socket.readyState < 2).length;
    }
    return { ...live, totals: { ...totals }, timers: timers.size, intervals: [...timers.values()].filter(timer => timer.kind === 'interval').length,
      timerDelays: [...timers.values()], domCanvases: document.querySelectorAll('canvas').length, domNodes: document.querySelectorAll('*').length };
  };
})();
