// Installed before application code. Weak references must not retain the objects being measured.
export function installLeakObservers() {
  const tracks = new Set();
  const contexts = new Set();
  const intervals = new Set();
  const frames = new Set();
  const rememberTrack = (track) => {
    tracks.add(new WeakRef(track));
    return track;
  };
  const rememberStream = (stream) => {
    stream.getTracks().forEach(rememberTrack);
    return stream;
  };
  for (const prototype of [HTMLCanvasElement.prototype, HTMLMediaElement.prototype]) {
    if (!prototype.captureStream) continue;
    const original = prototype.captureStream;
    prototype.captureStream = function (...args) {
      return rememberStream(original.apply(this, args));
    };
  }
  const clone = MediaStreamTrack.prototype.clone;
  MediaStreamTrack.prototype.clone = function () {
    return rememberTrack(clone.call(this));
  };
  const addTrack = MediaStream.prototype.addTrack;
  MediaStream.prototype.addTrack = function (track) {
    rememberTrack(track);
    return addTrack.call(this, track);
  };
  for (const method of ["getUserMedia", "getDisplayMedia"]) {
    if (!navigator.mediaDevices?.[method]) continue;
    const original = navigator.mediaDevices[method].bind(navigator.mediaDevices);
    navigator.mediaDevices[method] = async (...args) => rememberStream(await original(...args));
  }
  for (const name of ["AudioContext", "webkitAudioContext"]) {
    if (!window[name]) continue;
    window[name] = new Proxy(window[name], {
      construct(target, args) {
        const context = Reflect.construct(target, args);
        contexts.add(new WeakRef(context));
        const createDestination = context.createMediaStreamDestination.bind(context);
        context.createMediaStreamDestination = (...parameters) => {
          const destination = createDestination(...parameters);
          rememberStream(destination.stream);
          return destination;
        };
        return context;
      },
    });
  }
  const interval = window.setInterval.bind(window);
  const clear = window.clearInterval.bind(window);
  window.setInterval = (...args) => {
    const id = interval(...args);
    intervals.add(id);
    return id;
  };
  window.clearInterval = (id) => {
    intervals.delete(id);
    return clear(id);
  };
  // clearTimeout is permitted to cancel an interval, and vice versa.
  const clearTimeout = window.clearTimeout.bind(window);
  window.clearTimeout = (id) => {
    intervals.delete(id);
    return clearTimeout(id);
  };
  const request = window.requestAnimationFrame.bind(window);
  const cancel = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    const id = request((at) => {
      frames.delete(id);
      callback(at);
    });
    frames.add(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    frames.delete(id);
    return cancel(id);
  };
  const count = (references, predicate) => {
    const live = new Set();
    for (const reference of references) {
      const value = reference.deref();
      if (!value) references.delete(reference);
      else if (predicate(value)) live.add(value);
    }
    return live.size;
  };
  window.__callLeaks = () => ({
    videos: document.querySelectorAll("video").length,
    audios: document.querySelectorAll("audio").length,
    liveTracks: count(tracks, (track) => track.readyState === "live"),
    audioContexts: count(contexts, (context) => context.state !== "closed"),
    intervals: intervals.size,
    animationFrames: frames.size,
  });
}
