// Minimal request-body schema validator.
//
// Why hand-rolled instead of zod/joi:
//   - The codebase is dep-light (6 deps). Adding zod pulls in ~14 transitive
//     deps and ~150KB. A minimal validator covers the 8-10 shapes we need.
//   - The pattern we need is simple: required fields, types, enums, ranges,
//     string length caps, optional nested objects. No unions, no refinements,
//     no async transforms — those are where zod earns its keep and we don't
//     need them.
//
// If a route later needs complex validation, swap to zod by writing a
// `z.object({...}).safeParse(req.body)` and call this module's middleware
// shape. The integration point is validateBody() below.
//
// Usage:
//   import { validateBody, schemas } from './validate.mjs';
//   app.post('/api/foo', validateBody(schemas.createPatient), handler);
//
//   const schemas = {
//     createPatient: {
//       required: ['name', 'phone'],
//       props: {
//         name: { type: 'string', minLen: 1, maxLen: 200 },
//         phone: { type: 'string', pattern: '^[+0-9 ()-]{6,20}$' },
//         age: { type: 'integer', min: 0, max: 130, optional: true },
//       },
//     },
//   }

function fail(res, msg, field) {
  return res.status(400).json({
    error: { code: 'VALIDATION', message: msg, field: field || null },
  });
}

function checkType(value, spec, path) {
  const t = spec.type;
  if (t === 'string') {
    if (typeof value !== 'string') return `${path}: expected string, got ${typeof value}`;
    if (spec.minLen !== undefined && value.length < spec.minLen) return `${path}: shorter than minLen ${spec.minLen}`;
    if (spec.maxLen !== undefined && value.length > spec.maxLen) return `${path}: longer than maxLen ${spec.maxLen}`;
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) return `${path}: does not match pattern`;
    if (spec.enum && !spec.enum.includes(value)) return `${path}: must be one of ${spec.enum.join(',')}`;
  } else if (t === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return `${path}: expected integer`;
    if (spec.min !== undefined && value < spec.min) return `${path}: below min ${spec.min}`;
    if (spec.max !== undefined && value > spec.max) return `${path}: above max ${spec.max}`;
  } else if (t === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${path}: expected finite number`;
    if (spec.min !== undefined && value < spec.min) return `${path}: below min ${spec.min}`;
    if (spec.max !== undefined && value > spec.max) return `${path}: above max ${spec.max}`;
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') return `${path}: expected boolean`;
  } else if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path}: expected object`;
  } else if (t === 'array') {
    if (!Array.isArray(value)) return `${path}: expected array`;
    if (spec.minLen !== undefined && value.length < spec.minLen) return `${path}: shorter than minLen ${spec.minLen}`;
    if (spec.maxLen !== undefined && value.length > spec.maxLen) return `${path}: longer than maxLen ${spec.maxLen}`;
    if (spec.items) {
      for (let i = 0; i < value.length; i++) {
        const err = checkType(value[i], spec.items, `${path}[${i}]`);
        if (err) return err;
      }
    }
  } else {
    return `${path}: unknown schema type ${t}`;
  }
  return null;
}

/**
 * Express middleware factory. Validates req.body against the schema.
 * On failure, 400s with a structured error and stops the chain.
 *
 * The CSRF token field is automatically removed before validation so the
 * schema doesn't need to mention it.
 */
export function validateBody(schema) {
  if (!schema || !schema.props) {
    throw new Error('validateBody: schema must have { props: {...} }');
  }
  return (req, res, next) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // Drop csrf_token — the requireCsrf middleware already consumed it.
    const { csrf_token, ...rest } = body;

    // Required fields
    for (const f of schema.required || []) {
      if (rest[f] === undefined || rest[f] === null) {
        return fail(res, `missing required field`, f);
      }
    }
    // Per-field validation
    for (const [key, spec] of Object.entries(schema.props)) {
      const v = rest[key];
      if (v === undefined || v === null) {
        if (spec.optional) continue;
        continue; // already handled by `required` check
      }
      const err = checkType(v, spec, key);
      if (err) return fail(res, err, key);
    }
    // Disallow unknown fields (strict mode; flips off with schema.allowExtra)
    if (!schema.allowExtra) {
      const allowed = new Set(Object.keys(schema.props));
      for (const k of Object.keys(rest)) {
        if (!allowed.has(k)) {
          return fail(res, `unknown field`, k);
        }
      }
    }
    // Replace req.body with the cleaned version (without csrf_token)
    req.body = rest;
    next();
  };
}

/**
 * Validate query params against a schema (all values come in as strings).
 */
export function validateQuery(schema) {
  return (req, res, next) => {
    const q = req.query || {};
    const cleaned = {};
    for (const [key, spec] of Object.entries(schema.props)) {
      const raw = q[key];
      if (raw === undefined) {
        if (spec.optional) continue;
        if (schema.required?.includes(key)) {
          return fail(res, `missing required query param`, key);
        }
        continue;
      }
      // Coerce query strings to numbers/booleans when schema says so
      let v = raw;
      if (spec.type === 'integer') v = parseInt(raw, 10);
      else if (spec.type === 'number') v = Number(raw);
      else if (spec.type === 'boolean') v = /^(1|true|yes)$/i.test(String(raw));
      const err = checkType(v, spec, key);
      if (err) return fail(res, err, key);
      cleaned[key] = v;
    }
    req.cleanedQuery = cleaned;
    next();
  };
}

// ============ Schemas used by current routes ============
// Keep these close to the routes that use them. Add new ones as needed.
export const schemas = {
  // POST /api/patient/auth/login
  patientLogin: {
    required: ['phoneOrEmail', 'password'],
    props: {
      phoneOrEmail: { type: 'string', minLen: 4, maxLen: 100 },
      password: { type: 'string', minLen: 4, maxLen: 200 },
    },
  },
  // POST /api/patient/auth/signup
  patientSignup: {
    required: ['full_name', 'phone', 'password'],
    props: {
      full_name: { type: 'string', minLen: 1, maxLen: 200 },
      phone: { type: 'string', pattern: '^[+0-9 ()-]{6,20}$' },
      password: { type: 'string', minLen: 6, maxLen: 200 },
      email: { type: 'string', pattern: '^[^@]+@[^@]+\\.[^@]+$', optional: true },
      age: { type: 'integer', min: 0, max: 130, optional: true },
      sex: { type: 'string', enum: ['M', 'F', 'O', 'U'], optional: true },
    },
  },
  // POST /api/patient/vitals
  patientVitals: {
    required: ['metric', 'value'],
    props: {
      metric: { type: 'string', enum: ['systolic', 'diastolic', 'glucose', 'glucose_fasting', 'glucose_pp', 'weight', 'heart_rate', 'spo2', 'temperature', 'steps'] },
      value: { type: 'number' },
      unit: { type: 'string', maxLen: 16, optional: true },
      logged_at: { type: 'string', maxLen: 32, optional: true },
      notes: { type: 'string', maxLen: 500, optional: true },
    },
  },
  // POST /api/patient/adherence
  patientAdherence: {
    required: ['adherence_id', 'drug_name', 'schedule_slot', 'scheduled_at', 'status'],
    props: {
      adherence_id: { type: 'string', minLen: 1, maxLen: 64 },
      drug_name: { type: 'string', minLen: 1, maxLen: 200 },
      dose: { type: 'string', maxLen: 32, optional: true },
      schedule_slot: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'night', 'custom'] },
      scheduled_at: { type: 'string', minLen: 1, maxLen: 32 },
      taken_at: { type: 'string', maxLen: 32, optional: true },
      status: { type: 'string', enum: ['pending', 'taken', 'missed', 'skipped'] },
      notes: { type: 'string', maxLen: 500, optional: true },
    },
  },
  // POST /api/ai/ml/forecast
  mlForecast: {
    required: ['patient_id'],
    props: {
      patient_id: { type: 'string', minLen: 1, maxLen: 64 },
      metric: { type: 'string', enum: ['systolic', 'diastolic', 'glucose', 'weight', 'heart_rate', 'spo2'], optional: true },
      horizon_days: { type: 'integer', min: 1, max: 30, optional: true },
    },
  },
};
