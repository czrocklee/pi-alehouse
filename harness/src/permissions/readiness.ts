import { randomUUID } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";

export interface GuardReady {
  protocol: 1;
  sessionId: string;
  instanceId: string;
  nonce: string;
  profile: string;
  definitionDigest: string;
}

/** Resolve the PUBLIC permission service afresh; do not cache a session node. */
export function requireReadiness(
  bus: EventBus,
  getPermissionsService: (id: string) => unknown,
  sessionId: string,
  profile: string,
  definitionDigest: string,
): GuardReady {
  if (!getPermissionsService(sessionId)) throw new Error("PERMISSION_NOT_READY");
  const nonce = randomUUID();
  let acknowledgement: GuardReady | undefined;
  const unsubscribe = bus.on("pi-agent-harness:static-guard:ready", (data: unknown) => {
    const value = data as Partial<GuardReady> | undefined;
    if (value?.protocol === 1 && value.sessionId === sessionId && value.nonce === nonce &&
        value.profile === profile && value.definitionDigest === definitionDigest &&
        typeof value.instanceId === "string" && value.instanceId.length > 0) {
      acknowledgement = value as GuardReady;
    }
  });
  try {
    // The guard response is deliberately synchronous. A delayed/stale ack
    // cannot open admission, and absence never falls back to merely warning.
    bus.emit("pi-agent-harness:static-guard:probe", { sessionId, nonce, profile });
  } finally {
    unsubscribe();
  }
  if (!acknowledgement) throw new Error("STATIC_GUARD_NOT_READY");
  return acknowledgement;
}
