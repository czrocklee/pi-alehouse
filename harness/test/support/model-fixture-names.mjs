import assert from "node:assert/strict";

// Name every fresh Agent, including lifecycle Runs that can later enter the
// Owner-wide finished candidates. Replays keep their name; resumes keep the
// existing Agent's immutable name. This helper never loads a host or runs IO.
export function createModelFixtureSubmit(controller, settings, theme = "hare") {
  assert(typeof theme === "string" && /^[a-z][a-z0-9-]{0,6}$/.exec(theme)?.[0] === theme, "Invalid fixture name theme");
  const names = new Map();
  return (id, prompt, resume, options = {}) => {
    assert(typeof id === "string" && id.trim(), "A fixture request needs an ID");
    assert(Object.keys(options).every((key) => ["description", "max_turns", "max_duration_ms", "after"].includes(key)),
      "Fixture options cannot override Agent identity or settings");
    if (resume !== undefined) return controller.submit(id, { resume, prompt, ...options });
    let name = names.get(id);
    if (name === undefined) {
      name = `${theme}-${names.size + 1}`;
      assert(name.length <= 24 && /^[a-z][a-z0-9-]{0,23}$/.exec(name)?.[0] === name, "Invalid model fixture name");
      names.set(id, name);
    }
    return controller.submit(id, { prompt, description: prompt, ...options, name, settings });
  };
}
