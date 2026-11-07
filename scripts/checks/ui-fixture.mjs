// UI session checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
export function createUiFixture(createEventBus, ExtensionRunner) {
  function fixture(mode = "tui", sdkDispatch = false) {
    const handlers = new Map(),
      errors = [];
    const listeners = new Map();
    const titles = [];
    const widgets = new Map();
    const terminal = { setTitle: (title) => titles.push(title) };
    const originalSetTitle = terminal.setTitle;
    let name;
    let sessionNameReads = 0;
    const ctx = {
      mode,
      cwd: "/fixture/project",
      ui: {
        setTitle: (title) => terminal.setTitle(title),
        setWidget(key, factory) {
          widgets.get(key)?.dispose?.();
          widgets.delete(key);
          if (factory) widgets.set(key, factory({ terminal }));
        },
      },
    };
    const pi = {
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {
          const index = list.indexOf(handler);
          if (index >= 0) list.splice(index, 1);
        };
      },
      getSessionName: () => {
        sessionNameReads++;
        return name;
      },
      events: {
        on(event, handler) {
          const list = listeners.get(event) ?? new Set();
          list.add(handler);
          listeners.set(event, list);
          return () => list.delete(handler);
        },
        emit(event, value) {
          for (const handler of listeners.get(event) ?? []) handler(value);
        },
      },
    };
    if (sdkDispatch) pi.events = createEventBus();
    return {
      pi,
      ctx,
      titles,
      listeners,
      terminal,
      originalSetTitle,
      widgets,
      errors,
      sessionNameReads: () => sessionNameReads,
      rename: (value) => {
        name = value;
      },
      async emit(event, value = {}) {
        if (sdkDispatch)
          return ExtensionRunner.prototype.emit.call(
            {
              extensions: [{ path: "ui-fixture", handlers }],
              createContext: () => ctx,
              isSessionBeforeEvent: ExtensionRunner.prototype.isSessionBeforeEvent,
              emitError: (error) => errors.push(error),
            },
            { ...value, type: event },
          );
        for (const handler of [...(handlers.get(event) ?? [])]) await handler(value, ctx);
      },
    };
  }
  return fixture;
}
