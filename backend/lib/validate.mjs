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
 * Validate URL params against a schema (all values come in as strings).
 * Drops unknown params (strict mode). Writes the cleaned values into
 * req.params so downstream code can use them without re-parsing.
 *
 * Usage:
 *   app.get('/api/patients/:id',
 *     requireAuth,
 *     validateParams({ id: { type: 'string', minLen: 1, maxLen: 64, pattern: '^[a-zA-Z0-9_-]+$' } }),
 *     handler);
 */
export function validateParams(schema) {
  if (!schema || typeof schema !== 'object') {
    throw new Error('validateParams: schema must be an object');
  }
  const allowedKeys = new Set(Object.keys(schema));
  return (req, res, next) => {
    const p = req.params || {};
    const cleaned = {};
    for (const [key, spec] of Object.entries(schema)) {
      const raw = p[key];
      if (raw === undefined) {
        if (spec.optional) continue;
        return fail(res, `missing required path param`, key);
      }
      let v = raw;
      // Coerce URL strings (they're always strings from Express) per schema.
      if (spec.type === 'integer') v = parseInt(raw, 10);
      else if (spec.type === 'number') v = Number(raw);
      else if (spec.type === 'boolean') v = /^(1|true|yes)$/i.test(String(raw));
      const err = checkType(v, spec, key);
      if (err) return fail(res, err, key);
      cleaned[key] = v;
    }
    // Reject unknown params in strict mode (prevents `?evil=...` smuggling).
    for (const k of Object.keys(p)) {
      if (!allowedKeys.has(k)) {
        return fail(res, `unknown path param`, k);
      }
    }
    req.params = cleaned;
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
  // POST /api/patients — create new patient
  createPatient: {
    required: ['full_name', 'phone'],
    props: {
      full_name: { type: 'string', minLen: 1, maxLen: 200 },
      phone: { type: 'string', pattern: '^[+0-9 ()-]{6,20}$' },
      email: { type: 'string', pattern: '^[^@]+@[^@]+\\.[^@]+$', optional: true },
      dob: { type: 'string', maxLen: 32, optional: true },
      gender: { type: 'string', enum: ['M', 'F', 'O', 'U'], optional: true },
      age: { type: 'integer', min: 0, max: 130, optional: true },
      address: { type: 'string', maxLen: 500, optional: true },
    },
  },
  // POST /api/prescriptions — write new prescription
  createPrescription: {
    required: ['patient_id', 'diagnosis_code', 'rx_items'],
    props: {
      patient_id: { type: 'string', minLen: 1, maxLen: 64 },
      diagnosis_code: { type: 'string', minLen: 1, maxLen: 32 },
      diagnosis_label: { type: 'string', maxLen: 300, optional: true },
      rx_items: { type: 'array', minLen: 1, maxLen: 50, items: { type: 'object' } },
      notes: { type: 'string', maxLen: 4000, optional: true },
      followup_in_days: { type: 'integer', min: 0, max: 365, optional: true },
      advice: { type: 'string', maxLen: 2000, optional: true },
    },
  },
  // POST /api/vitals — doctor-side vitals write
  doctorVitalsWrite: {
    required: ['patient_id', 'metric', 'value'],
    props: {
      patient_id: { type: 'string', minLen: 1, maxLen: 64 },
      metric: { type: 'string', enum: ['systolic', 'diastolic', 'glucose', 'glucose_fasting', 'glucose_pp', 'weight', 'heart_rate', 'spo2', 'temperature', 'steps'] },
      value: { type: 'number' },
      unit: { type: 'string', maxLen: 16, optional: true },
      recorded_at: { type: 'string', maxLen: 32, optional: true },
      notes: { type: 'string', maxLen: 500, optional: true },
    },
  },
  // POST /api/patients/:id/notes — clinical note
  createNote: {
    required: ['body'],
    props: {
      note_type: { type: 'string', enum: ['clinical', 'soap', 'followup', 'referral'], optional: true },
      body: { type: 'string', minLen: 1, maxLen: 4000 },
      is_pinned: { type: 'boolean', optional: true },
    },
  },
  // POST /api/reminders — create reminder
  createReminder: {
    required: ['patient_id', 'kind', 'title', 'schedule_type'],
    props: {
      patient_id: { type: 'string', minLen: 1, maxLen: 64 },
      kind: { type: 'string', enum: ['medication', 'appointment', 'lab', 'vitals', 'custom'] },
      title: { type: 'string', minLen: 1, maxLen: 200 },
      body: { type: 'string', maxLen: 1000, optional: true },
      schedule_type: { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly'] },
      schedule_at: { type: 'string', maxLen: 32, optional: true },
      channel: { type: 'string', enum: ['whatsapp', 'sms', 'push', 'email'], optional: true },
    },
  },
  // POST /api/telemedicine/sessions
  createTeleSession: {
    required: ['patient_id', 'scheduled_at'],
    props: {
      patient_id: { type: 'string', minLen: 1, maxLen: 64 },
      scheduled_at: { type: 'string', minLen: 1, maxLen: 32 },
      channel: { type: 'string', enum: ['webrtc', 'phone', 'video'], optional: true },
    },
  },
  // POST /api/telemedicine/sessions/:id/end
  endTeleSession: {
    props: {
      notes: { type: 'string', maxLen: 4000, optional: true },
      followup_rx_id: { type: 'string', maxLen: 64, optional: true },
    },
  },
  // POST /api/ai/ocr/* — image payload validation
  ocrImage: {
    required: ['image'],
    props: {
      image: { type: 'string', minLen: 32, maxLen: 8_000_000 }, // base64 ~6MB image
    },
  },
  // POST /api/ai/nlp/entities, /api/ai/nlp/icd10
  nlpText: {
    required: ['text'],
    props: {
      text: { type: 'string', minLen: 1, maxLen: 20_000 },
      top_k: { type: 'integer', min: 1, max: 50, optional: true },
    },
  },
  // POST /api/ai/ml/risk, /api/ai/ml/anomaly
  mlPatientOp: {
    required: ['patient_id'],
    props: {
      patient_id: { type: 'string', minLen: 1, maxLen: 64 },
      metric: { type: 'string', enum: ['systolic', 'diastolic', 'glucose', 'weight', 'heart_rate', 'spo2'], optional: true },
    },
  },
  // POST /api/ai/agents/llm
  agentLlm: {
    required: ['agent'],
    props: {
      agent: { type: 'string', enum: ['soap', 'coding', 'lab_triage', 'drug_ix', 'followup'] },
      transcript: { type: 'string', maxLen: 20_000, optional: true },
      patient_id: { type: 'string', maxLen: 64, optional: true },
      test_name: { type: 'string', maxLen: 200, optional: true },
      value: { type: 'string', maxLen: 200, optional: true },
      unit: { type: 'string', maxLen: 50, optional: true },
      interactions: { type: 'array', optional: true, items: { type: 'object' } },
      allergy_alerts: { type: 'array', optional: true, items: { type: 'object' } },
    },
  },
  // POST /api/rag/query
  ragQuery: {
    required: ['query'],
    props: {
      query: { type: 'string', minLen: 3, maxLen: 2000 },
    },
  },
  // POST /api/drugs/check-interactions
  checkInteractions: {
    required: ['drugs'],
    props: {
      drugs: { type: 'array', minLen: 2, maxLen: 30, items: { type: 'string' } },
    },
  },
  // POST /api/tasks/:id/complete, /api/tasks/:id/dismiss — body is empty,
  // but the path params need validation. Schema lives in `paramSchemas`.
};

// ============ Param schemas (for URL :id style) ============
export const paramSchemas = {
  // Generic IDs — alphanumeric + dash + underscore, length-capped.
  id: { id: { type: 'string', minLen: 1, maxLen: 64, pattern: '^[a-zA-Z0-9_:-]+$' } },
  pid: { pid: { type: 'string', minLen: 1, maxLen: 64, pattern: '^[a-zA-Z0-9_:-]+$' } },
  nid: { nid: { type: 'string', minLen: 1, maxLen: 64, pattern: '^[a-zA-Z0-9_-]+$' } },
  drugName: { drugName: { type: 'string', minLen: 1, maxLen: 200, pattern: '^[a-zA-Z0-9 _()/-]+$' } },
};
