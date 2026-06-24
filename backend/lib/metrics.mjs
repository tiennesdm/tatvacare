// TatvaCare in-process metrics — Prometheus text exposition format.
//
// Why a hand-rolled registry instead of `prom-client`:
//   - prom-client adds ~15 deps (brotli, sqlstring, etc.) and ~250KB.
//   - Our metric surface is tiny: a dozen counters + a few histograms.
//   - Zero deps keeps the deploy story simple (no security audit of
//     prom-client's transitive tree).
//
// What we expose at GET /metrics:
//   - Counters (monotonic, never reset inside the process lifetime):
//       http_requests_total{route,method,status}
//       ai_calls_total{endpoint,outcome}     # outcome=ok|timeout|5xx|network_error
//       ai_circuit_state{state}              # 0|1 for closed|open (gauge-ish)
//       audit_writes_total{kind}             # audit_log vs phi_access_log
//   - Histograms (request duration in seconds, fixed buckets per Prometheus
//     convention for HTTP: 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10):
//       http_request_duration_seconds{route,method}
//   - Gauges (snapshot values):
//       vbp_pool_in_use                       # connections currently leased
//       vbp_pool_free                         # connections idle
//       vbp_pool_total
//       process_uptime_seconds
//       nodejs_heap_used_bytes
//
// Format is the Prometheus text exposition format v1.0.0 — consumable by
// any Prometheus / VictoriaMetrics / Grafana Agent / OTLP collector.
//
// Cardinality safety:
//   - `route` is the matched Express route pattern (e.g. `/api/patients/:id`),
//     NOT the raw URL. Otherwise every distinct patient_id becomes a new
//     series and the metrics DB explodes.
//   - `status` is the integer class only at moderate cardinality; we keep
//     the full code so Grafana can break down by 5xx vs 4xx.

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// --------- primitive types ---------
class Counter {
  constructor(name, help, labelNames = []) {
    this.name = name; this.help = help; this.labelNames = labelNames;
    this.values = new Map(); // key -> number
  }
  inc(labels = {}, n = 1) {
    const k = this.labelNames.map(n => labels[n] ?? '').join('|');
    this.values.set(k, (this.values.get(k) || 0) + n);
  }
  render() {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) {
      out.push(`${this.name} 0`);
      return out.join('\n');
    }
    for (const [k, v] of this.values) {
      const labels = this._labelStr(k);
      out.push(`${this.name}${labels} ${v}`);
    }
    return out.join('\n');
  }
  _labelStr(k) {
    if (this.labelNames.length === 0) return '';
    const parts = this.labelNames.map((n, i) => `${n}="${(k.split('|')[i] || '').replace(/"/g, '\\"')}"`);
    return `{${parts.join(',')}}`;
  }
}

class Gauge {
  constructor(name, help, labelNames = []) {
    this.name = name; this.help = help; this.labelNames = labelNames;
    this.values = new Map();
  }
  set(labels, v) {
    const k = this.labelNames.map(n => labels[n] ?? '').join('|');
    this.values.set(k, v);
  }
  render() {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    if (this.values.size === 0) return out.join('\n');
    for (const [k, v] of this.values) {
      const labels = this._labelStr(k);
      out.push(`${this.name}${labels} ${v}`);
    }
    return out.join('\n');
  }
  _labelStr(k) {
    if (this.labelNames.length === 0) return '';
    const parts = this.labelNames.map((n, i) => `${n}="${(k.split('|')[i] || '').replace(/"/g, '\\"')}"`);
    return `{${parts.join(',')}}`;
  }
}

class Histogram {
  constructor(name, help, labelNames = [], buckets = BUCKETS) {
    this.name = name; this.help = help; this.labelNames = labelNames;
    this.buckets = buckets;
    // key -> { count, sum, bucketCounts: [] }
    this.values = new Map();
  }
  observe(labels, v) {
    const k = this.labelNames.map(n => labels[n] ?? '').join('|');
    let e = this.values.get(k);
    if (!e) { e = { count: 0, sum: 0, bucketCounts: new Array(this.buckets.length).fill(0) }; this.values.set(k, e); }
    e.count++;
    e.sum += v;
    for (let i = 0; i < this.buckets.length; i++) {
      if (v <= this.buckets[i]) e.bucketCounts[i]++;
    }
  }
  render() {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, e] of this.values) {
      const labels = this._labelStr(k);
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative = e.bucketCounts[i];
        const b = this.buckets[i];
        const bucketLabels = labels
          ? labels.slice(0, -1) + `,le="${b}"}`
          : `{le="${b}"}`;
        out.push(`${this.name}_bucket${bucketLabels} ${cumulative}`);
      }
      const infLabels = labels
        ? labels.slice(0, -1) + `,le="+Inf"}`
        : `{le="+Inf"}`;
      out.push(`${this.name}_bucket${infLabels} ${e.count}`);
      out.push(`${this.name}_sum${labels} ${e.sum.toFixed(6)}`);
      out.push(`${this.name}_count${labels} ${e.count}`);
    }
    return out.join('\n');
  }
  _labelStr(k) {
    if (this.labelNames.length === 0) return '';
    const parts = this.labelNames.map((n, i) => `${n}="${(k.split('|')[i] || '').replace(/"/g, '\\"')}"`);
    return `{${parts.join(',')}}`;
  }
}

// --------- registry ---------
export const registry = {
  httpRequests: new Counter('http_requests_total', 'HTTP requests handled', ['route', 'method', 'status']),
  httpDuration: new Histogram('http_request_duration_seconds', 'HTTP request duration', ['route', 'method']),
  aiCalls: new Counter('ai_calls_total', 'AI service calls', ['endpoint', 'outcome']),
  aiCircuitState: new Gauge('ai_circuit_state', 'AI circuit breaker state (0=closed, 1=open, 2=half-open)', ['state']),
  auditWrites: new Counter('audit_writes_total', 'Audit log writes', ['kind']),
  phiLogFailures: new Counter('phi_log_failures_total', 'PHI access log INSERT failures (table missing, db down, etc.)', ['reason']),
  vbpInUse: new Gauge('vbp_pool_in_use', 'VBP connections currently leased'),
  vbpFree: new Gauge('vbp_pool_free', 'VBP connections idle in pool'),
  vbpTotal: new Gauge('vbp_pool_total', 'VBP connections total'),
  processUptime: new Gauge('process_uptime_seconds', 'Node process uptime in seconds'),
  heapUsed: new Gauge('nodejs_heap_used_bytes', 'Node V8 heap used in bytes'),
};

// --------- snapshot gauges (called periodically + on /metrics scrape) ---------
export function snapshotGauges({ pool } = {}) {
  registry.processUptime.set({}, Math.floor(process.uptime()));
  const mem = process.memoryUsage();
  registry.heapUsed.set({}, mem.heapUsed);
  if (pool && pool._stats) {
    const s = pool._stats();
    registry.vbpInUse.set({}, s.in_use);
    registry.vbpFree.set({}, s.free);
    registry.vbpTotal.set({}, s.total);
  }
}

// --------- middleware: per-request metrics ---------
// IMPORTANT: this must run AFTER routing (so req.route is populated).
// In Express, that's typically `app.use(metricsMiddleware)` mounted
// before routes — by the time res.on('finish') fires, the router has
// matched the route and req.route is set.
export function metricsMiddleware() {
  return (req, res, next) => {
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route?.path || (req.baseUrl ? req.baseUrl : '(unknown)');
      const labels = { route, method: req.method, status: String(res.statusCode) };
      registry.httpRequests.inc(labels);
      const durSec = Number(process.hrtime.bigint() - t0) / 1e9;
      registry.httpDuration.observe({ route, method: req.method }, durSec);
    });
    next();
  };
}

// --------- exporter ---------
export function renderMetrics() {
  snapshotGauges(globalThis.__tatvacare_metrics_deps || {});
  const parts = [];
  for (const k of Object.keys(registry)) {
    const m = registry[k];
    if (m && typeof m.render === 'function') parts.push(m.render());
  }
  return parts.join('\n\n') + '\n';
}
