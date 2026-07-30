export class ObservableManager<State> {
  readonly #listeners = new Set<(state: State) => void>();
  #state: State;

  constructor(initialState: State) {
    this.#state = initialState;
  }

  readonly getState = (): State => this.#state;

  readonly subscribe = (listener: (state: State) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  protected replaceState(state: State): void {
    if (Object.is(state, this.#state)) return;
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  protected patchState(patch: Partial<State>): void {
    this.replaceState({ ...this.#state, ...patch });
  }
}
