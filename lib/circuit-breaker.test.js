import { describe, expect, test } from "bun:test";
import {
  CircuitBreakerRegistry,
  DEFAULT_FAILURE_THRESHOLD,
  PROBE_INTERVAL_MS,
  isConnectionFailure,
} from "./circuit-breaker.js";

describe("isConnectionFailure", () => {
  test("detects SSH transport errors", () => {
    expect(isConnectionFailure(new Error("scp failed: exit 255"))).toBe(true);
    expect(isConnectionFailure(new Error("Connection refused"))).toBe(true);
    expect(isConnectionFailure(new Error("Connection reset by peer"))).toBe(true);
  });

  test("does not treat permission errors as connection failures", () => {
    expect(isConnectionFailure(new Error("Permission denied (publickey)"))).toBe(false);
    expect(isConnectionFailure(new Error("scp: /var/www/x: Permission denied"))).toBe(false);
  });
});

describe("CircuitBreakerRegistry", () => {
  test("opens after consecutive connection failures", () => {
    const registry = new CircuitBreakerRegistry();
    const err = new Error("exit 255");
    const id = "deploy@host:22:~/.ssh/id_ed25519";

    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD - 1; i++) {
      const result = registry.recordFailure(id, err, { now: 1000 });
      expect(result.opened).toBe(false);
      expect(registry.shouldBlock(id, 1000)).toBe(false);
    }

    const opened = registry.recordFailure(id, err, { now: 2000 });
    expect(opened.opened).toBe(true);
    expect(registry.shouldBlock(id, 2000)).toBe(true);
    expect(registry.shouldBlock(id, 2000 + PROBE_INTERVAL_MS - 1)).toBe(true);
    expect(registry.isProbing(id, 2000 + PROBE_INTERVAL_MS)).toBe(true);
  });

  test("permission errors do not open the breaker", () => {
    const registry = new CircuitBreakerRegistry();
    const id = "user@host:22:key";
    for (let i = 0; i < 10; i++) {
      registry.recordFailure(id, new Error("Permission denied"), { now: i });
    }
    expect(registry.isOpen(id)).toBe(false);
  });

  test("recordSuccess closes the breaker", () => {
    const registry = new CircuitBreakerRegistry();
    const id = "user@host:22:key";
    const err = new Error("exit 255");
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
      registry.recordFailure(id, err, { now: 1000 });
    }
    expect(registry.isOpen(id)).toBe(true);
    registry.recordSuccess(id);
    expect(registry.isOpen(id)).toBe(false);
    expect(registry.shouldBlock(id, 999_999)).toBe(false);
  });

  test("notify open only once until success", () => {
    const registry = new CircuitBreakerRegistry();
    const id = "user@host:22:key";
    const err = new Error("exit 255");
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
      registry.recordFailure(id, err, { now: 1000 });
    }
    expect(registry.shouldNotifyOpen(id)).toBe(true);
    registry.markNotifiedOpen(id);
    expect(registry.shouldNotifyOpen(id)).toBe(false);
  });
});
