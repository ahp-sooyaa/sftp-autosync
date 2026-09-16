export const DEFAULT_FAILURE_THRESHOLD = 3;
export const PROBE_INTERVAL_MS = 120_000;

/**
 * Whether an error looks like a transport/SSH connection failure (not per-file permission).
 * @param {unknown} err
 */
export function isConnectionFailure(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  if (msg.includes("permission denied") && !msg.includes("exit 255")) return false;
  if (msg.includes("exit 255")) return true;
  if (msg.includes("connection refused")) return true;
  if (msg.includes("connection reset")) return true;
  if (msg.includes("connection timed out")) return true;
  if (msg.includes("network is unreachable")) return true;
  if (msg.includes("no route to host")) return true;
  if (msg.includes("broken pipe")) return true;
  if (msg.includes("control socket")) return true;
  if (msg.includes("could not resolve hostname")) return true;
  if (msg.includes("host is down")) return true;
  if (msg.includes("operation timed out")) return true;
  return false;
}

/**
 * Per-SSH-identity circuit breaker (in-memory; resets on daemon restart).
 */
export class CircuitBreakerRegistry {
  /** @type {Map<string, { consecutiveFailures: number, open: boolean, probeAt: number, notifiedOpen: boolean }>} */
  #states = new Map();

  /** True when the breaker is open and probe time has not arrived. */
  shouldBlock(identity, now = Date.now()) {
    const state = this.#states.get(identity);
    if (!state?.open) return false;
    return now < state.probeAt;
  }

  /** True when the breaker is open and it is time to probe. */
  isProbing(identity, now = Date.now()) {
    const state = this.#states.get(identity);
    if (!state?.open) return false;
    return now >= state.probeAt;
  }

  probeAt(identity) {
    return this.#states.get(identity)?.probeAt ?? null;
  }

  isOpen(identity) {
    return Boolean(this.#states.get(identity)?.open);
  }

  recordSuccess(identity) {
    this.#states.delete(identity);
  }

  /**
   * @returns {{ opened: boolean, isConnectionFailure: boolean }}
   */
  recordFailure(identity, err, { now = Date.now(), threshold = DEFAULT_FAILURE_THRESHOLD } = {}) {
    if (!isConnectionFailure(err)) {
      return { opened: false, isConnectionFailure: false };
    }

    let state = this.#states.get(identity);
    if (!state) {
      state = { consecutiveFailures: 0, open: false, probeAt: 0, notifiedOpen: false };
      this.#states.set(identity, state);
    }

    state.consecutiveFailures += 1;

    if (state.consecutiveFailures >= threshold && !state.open) {
      state.open = true;
      state.probeAt = now + PROBE_INTERVAL_MS;
      return { opened: true, isConnectionFailure: true };
    }

    if (state.open) {
      state.probeAt = now + PROBE_INTERVAL_MS;
    }

    return { opened: false, isConnectionFailure: true };
  }

  shouldNotifyOpen(identity) {
    const state = this.#states.get(identity);
    return Boolean(state?.open && !state.notifiedOpen);
  }

  markNotifiedOpen(identity) {
    const state = this.#states.get(identity);
    if (state) state.notifiedOpen = true;
  }
}
