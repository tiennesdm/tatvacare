// Circuit breaker for the Python AI service.
//
// Why this exists:
//   The Node backend proxies ~12 endpoints to the AI service on :7100.
//   If the AI service hangs (e.g. a Whisper request blocks forever on
//   disk I/O, or PyTorch OOMs and starts producing timeouts), every
//   pending fetch in Node ties up an event-loop microtask and slowly
//   bleeds the Node process. A circuit breaker stops sending requests
//   for a cooldown window once consecutive failures cross a threshold,
//   letting the AI service recover without drowning Node.
//
// Algorithm — half-open after `resetMs`:
//   state CLOSED: requests pass through. N consecutive failures flip to OPEN.
//   state OPEN:   requests fail fast with `CircuitOpenError`. After resetMs,
//                 the NEXT request is allowed through (HALF_OPEN probe).
//   state HALF_OPEN: one probe at a time. Success → CLOSED. Failure → OPEN.
//
// Why not just retry with exponential backoff:
//   Retry-on-error is great for transient blips. A circuit breaker is for
//   sustained downstream outages — different problem. The two compose:
//   breaker decides IF to call, retry decides HOW OFTEN once allowed.
//
// Per-endpoint or global:
//   We keep ONE breaker shared across all AI endpoints. Rationale: they
//   share a single Python process + GPU/CPU + DB pool. If OCR is down,
//   DL is probably also down — sending more requests doesn't help.

import { logger } from './logger.mjs';
import { registry } from './metrics.mjs';

export class CircuitOpenError extends Error {
  constructor(name, msUntilRetry) {
    super(`circuit_open: ${name} (retry in ${msUntilRetry}ms)`);
    this.code = 'CIRCUIT_OPEN';
    this.msUntilRetry = msUntilRetry;
  }
}

export class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {string} opts.name             — for logging + metrics
   * @param {number} [opts.failureThreshold=5]    — consecutive failures to open
   * @param {number} [opts.resetMs=10_000]        — cooldown before half-open probe
   * @param {number} [opts.halfOpenMaxConcurrent=1] — concurrent probes in half-open
   */
  constructor(opts = {}) {
    this.name = opts.name || 'circuit';
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetMs = opts.resetMs ?? 10_000;
    this.halfOpenMaxConcurrent = opts.halfOpenMaxConcurrent ?? 1;
    this.state = 'CLOSED';          // CLOSED | OPEN | HALF_OPEN
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.inFlightProbe = 0;
    this._syncGauge();
  }

  _syncGauge() {
    // ai_circuit_state gauge per state: 0 or 1
    registry.aiCircuitState.set({ state: 'closed' }, this.state === 'CLOSED' ? 1 : 0);
    registry.aiCircuitState.set({ state: 'open' },   this.state === 'OPEN' ? 1 : 0);
    registry.aiCircuitState.set({ state: 'half_open' }, this.state === 'HALF_OPEN' ? 1 : 0);
  }

  /**
   * Wrap an async fn so it goes through the breaker.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async exec(fn) {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.resetMs) {
        registry.aiCalls.inc({ endpoint: this.name, outcome: 'circuit_open' });
        throw new CircuitOpenError(this.name, this.resetMs - elapsed);
      }
      // Cooldown elapsed → HALF_OPEN, allow exactly one probe.
      this.state = 'HALF_OPEN';
      this._syncGauge();
    }
    if (this.state === 'HALF_OPEN') {
      if (this.inFlightProbe >= this.halfOpenMaxConcurrent) {
        registry.aiCalls.inc({ endpoint: this.name, outcome: 'circuit_open' });
        throw new CircuitOpenError(this.name, 500);
      }
      this.inFlightProbe++;
    }
    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (e) {
      this._onFailure(e);
      throw e;
    } finally {
      if (this.state === 'HALF_OPEN') this.inFlightProbe--;
    }
  }

  _onSuccess() {
    this.consecutiveFailures = 0;
    if (this.state !== 'CLOSED') {
      logger.info('circuit_closed', { breaker: this.name, after_open_ms: Date.now() - this.openedAt });
      this.state = 'CLOSED';
      this._syncGauge();
    }
  }
  _onFailure(err) {
    this.consecutiveFailures++;
    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold) {
      if (this.state !== 'OPEN') {
        logger.warn('circuit_opened', { breaker: this.name, reason: err?.message?.slice(0, 100), failures: this.consecutiveFailures });
        this.state = 'OPEN';
        this.openedAt = Date.now();
        this._syncGauge();
      }
    }
  }

  /** For /metrics + tests. */
  snapshot() {
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      resetMs: this.resetMs,
    };
  }
}

// Singleton used by the AI service proxy in server.mjs.
export const aiBreaker = new CircuitBreaker({
  name: 'ai_service',
  failureThreshold: Number(process.env.AI_BREAKER_THRESHOLD || 5),
  resetMs: Number(process.env.AI_BREAKER_RESET_MS || 10_000),
});
