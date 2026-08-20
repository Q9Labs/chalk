export function subscribeSnapshot(listeners: Set<() => void>, listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function observePublications<T>(listeners: Set<() => void>, listener: (value: T) => void, project: () => T): () => void {
  const publication = () => listener(project());
  listeners.add(publication);
  listener(project());
  return () => {
    listeners.delete(publication);
  };
}
