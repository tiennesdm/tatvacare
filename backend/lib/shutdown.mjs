// Graceful shutdown coordinator.
//
// Why:
//   Container orchestrators (Docker, Kubernetes, ECS, Nomad) and process
//   managers (PM2, systemd) send SIGTERM by convention. Without a handler,
//   Node exits immediately — any in-flight HTTP request is severed mid-response,
//   the VBP pool is closed mid-query, and AI service child requests are
//   killed without cleanup. For a chronic-care EMR, that means the doctor
//   who clicked "Save Rx" gets a half-written record.
//
//   This module implements the standard 4-phase shutdown:
//
//     1. STOP_ACCEPTING  — httpServer.close() stops accepting new TCP
//                          connections but lets in-flight requests finish.
//     2. DRAIN           — wait up to `graceMs` for in-flight to finish,
//                          logging progress every 2s.
//     3. HARD_STOP       — after grace, force-close remaining sockets so
//                          we don't hang forever on a stuck request.
//     4. CLEANUP         — close the VBP pool, log "shutdown_complete",
//                          exit 0 (or 1 on second SIGTERM during shutdown).
//
//   SIGINT (Ctrl+C in dev) goes through the same path.
//
//   Second SIGTERM during shutdown → hard exit(1). This is the contract
//   operators expect: one TERM = graceful, two = "really stop NOW".

import { logger } from './logger.mjs';

export class ShutdownCoordinator {
  /**
   * @param {object} opts
   * @param {import('http').Server} opts.httpServer — required
   * @param {() => Promise<void>} opts.onDraining — called after server stops accepting (e.g. mark /readyz = not-ready)
   * @param {() => Promise<void>} opts.onCleanup  — called before process.exit (e.g. close VBP pool)
   * @param {number} [opts.graceMs=15000]
   * @param {() => number} [opts.inFlight] — returns current in-flight count; if absent, we trust server.close()
   */
  constructor(opts) {
    if (!opts || !opts.httpServer) throw new Error('ShutdownCoordinator requires opts.httpServer');
    this.httpServer = opts.httpServer;
    this.onDraining = opts.onDraining || (async () => {});
    this.onCleanup = opts.onCleanup || (async () => {});
    this.graceMs = opts.graceMs ?? 15_000;
    this.inFlight = opts.inFlight || (() => 0);
    this.shuttingDown = false;
    this.forceExited = false;
  }

  install() {
    process.on('SIGTERM', () => this._handle('SIGTERM'));
    process.on('SIGINT', () => this._handle('SIGINT'));
    process.on('uncaughtException', (err) => {
      logger.error('uncaught_exception', { err: err?.message, stack: err?.stack?.split('\n').slice(0, 3).join(' | ') });
      this._handle('uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
      logger.error('unhandled_rejection', { reason: String(reason)?.slice(0, 200) });
      // Don't shutdown on unhandled rejection — log only. A single bad
      // promise shouldn't take down the whole server. We still treat
      // uncaughtException as fatal because those typically indicate
      // memory corruption or a bug that will keep producing errors.
    });
  }

  _handle(signal) {
    if (this.shuttingDown) {
      logger.warn('shutdown_force', { signal, note: 'second signal during shutdown — hard exit' });
      this.forceExited = true;
      process.exit(1);
    }
    this.shuttingDown = true;
    const t0 = Date.now();
    logger.info('shutdown_started', { signal, grace_ms: this.graceMs });

    // Phase 1: mark readiness false so load balancers stop sending traffic
    //          (the /readyz handler reads this.shuttingDown).
    Promise.resolve(this.onDraining()).catch((e) => logger.error('shutdown_draining_err', { err: e?.message }));

    // Phase 2: stop accepting new connections. Existing keep-alive
    //          connections are kept alive; server.close() callback fires
    //          when all are closed.
    this.httpServer.close((err) => {
      if (err) logger.warn('shutdown_server_close_err', { err: err?.message });
      this._finish(t0, 'http_closed');
    });

    // Phase 2 cont: poll in-flight. If we have a count and it's stuck,
    //               force exit at graceMs. server.close() alone can hang
    //               indefinitely if a handler holds a connection open.
    const poll = setInterval(() => {
      const remaining = this.inFlight();
      const elapsed = Date.now() - t0;
      logger.info('shutdown_draining', { in_flight: remaining, elapsed_ms: elapsed });
      if (remaining === 0) {
        clearInterval(poll);
        // server.close callback will fire once sockets are actually closed.
      }
      if (elapsed > this.graceMs) {
        clearInterval(poll);
        logger.warn('shutdown_grace_exceeded', { in_flight: remaining, elapsed_ms: elapsed });
        this._finish(t0, 'grace_exceeded');
      }
    }, 2_000);

    // Hard floor: if anything prevents _finish from being called,
    //             exit anyway at graceMs * 1.5.
    setTimeout(() => {
      if (!this.forceExited) {
        logger.error('shutdown_hard_timeout', { elapsed_ms: Date.now() - t0 });
        process.exit(1);
      }
    }, Math.floor(this.graceMs * 1.5)).unref();
  }

  async _finish(t0, reason) {
    try {
      await this.onCleanup();
    } catch (e) {
      logger.error('shutdown_cleanup_err', { err: e?.message });
    }
    logger.info('shutdown_complete', { reason, duration_ms: Date.now() - t0 });
    process.exit(this.forceExited ? 1 : 0);
  }
}
