import { randomUUID } from "node:crypto";

function safeObject(object) {
  if (!object || typeof object !== "object") return null;
  const type = typeof object.type === "string" ? object.type : "Object";
  const id = typeof object.id === "string" ? object.id : "pending";
  const state = typeof object.state === "string" ? object.state : "unknown";
  return { type, id, state };
}

function safeError(error) {
  if (!error || typeof error !== "object") return null;
  const value = {};
  for (const field of ["name", "code", "message", "requestId"]) {
    if (typeof error[field] === "string" && error[field]) value[field] = error[field];
  }
  if (
    typeof error.statusCode === "string" ||
    typeof error.statusCode === "number"
  ) {
    value.statusCode = error.statusCode;
  }
  return Object.keys(value).length ? value : null;
}

export function createSandboxServiceMonitor({
  now = Date.now,
  idFactory = randomUUID,
  historyLimit = 40,
} = {}) {
  const active = new Map();
  const history = [];
  const objects = new Map();

  function remember(object) {
    const safe = safeObject(object);
    if (!safe) return null;
    objects.set(`${safe.type}:${safe.id}`, safe);
    return safe;
  }

  function publicCall(call, currentTime) {
    return {
      id: call.id,
      api: call.api,
      target: call.target,
      state: call.state,
      durationMs: call.durationMs ?? Math.max(0, currentTime - call.startedAtMs),
      startedAt: new Date(call.startedAtMs).toISOString(),
      object: call.object,
      ...(call.error ? { error: call.error } : {}),
      ...(call.operationContext
        ? { operationContext: call.operationContext }
        : {}),
    };
  }

  function finish(id, state, result = {}) {
    const call = active.get(id);
    if (!call) return;
    active.delete(id);
    const object = remember(result.object) ?? call.object;
    history.unshift({
      ...call,
      state,
      object,
      error: safeError(result.error),
      durationMs: Math.max(0, now() - call.startedAtMs),
    });
    if (history.length > historyLimit) history.length = historyLimit;
  }

  return {
    reset() {
      active.clear();
      history.length = 0;
      objects.clear();
    },
    begin({ api, target, object, operationContext }) {
      const id = idFactory();
      const safe = remember(object);
      active.set(id, {
        id,
        api,
        target,
        object: safe,
        operationContext: operationContext && typeof operationContext === "object"
          && typeof operationContext.label === "string"
          && typeof operationContext.value === "string"
          ? { label: operationContext.label, value: operationContext.value }
          : null,
        state: "running",
        startedAtMs: now(),
      });
      return id;
    },
    succeed(id, result) {
      finish(id, "succeeded", result);
    },
    fail(id, result) {
      finish(id, "failed", result);
    },
    snapshot() {
      const currentTime = now();
      const calls = [
        ...[...active.values()].map((call) => publicCall(call, currentTime)),
        ...history.map((call) => publicCall(call, currentTime)),
      ].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
      return {
        generatedAt: new Date(currentTime).toISOString(),
        calls,
        objects: [...objects.values()].reverse().slice(0, 12),
      };
    },
  };
}
