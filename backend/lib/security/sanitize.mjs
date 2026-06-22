// Input sanitisation — strip dangerous HTML / scripts from user-supplied free-text.
//
// Why we sanitize at the boundary (not at render time):
//   TatvaCare's frontend renders patient notes / vitals notes / Rx advice
//   in plain text contexts (.innerText, .textContent) — but also in
//   dashboards where a colleague may paste a note into an HTML template.
//   If a doctor pastes "<script>alert(1)</script>" into the Rx advice
//   field today and we later switch to .innerHTML, stored XSS becomes
//   instant. Sanitising at write time means the stored row is safe no
//   matter what rendering strategy a future view uses. This is
//   defence-in-depth — output encoding should ALSO be applied at render
//   time, but that's a frontend change out of scope here.
//
// Whitelist rationale:
//   - b / i / em / strong / br / p / ul / ol / li — common medical-formatting
//     tags doctors paste from Word ("<b>BP:</b> 142/90"). Everything else
//     is a vector.
//   - href on a — DOCTORS need to embed URLs (drug monographs, lab
//     reports) so we allow <a href="..."> but only with safe protocols
//     (http, https, mailto) — never javascript:.
//   - allow empty tags so a stray "<b></b>" round-trips without complaint.
//
// What we reject (400):
//   - Any `<script>` tag (open or close).
//   - `javascript:` protocol on any URL.
//   - Any `on*=` attribute (onclick, onerror, onload, onmouseover, ...).
//   - `<iframe>`, `<object>`, `<embed>`, `<form>`, `<input>`.
//
// Field-level config:
//   We accept an array of field names. Whitelisted by default are the
//   free-text fields called out in the spec:
//     notes, advice, allergies, rx_instructions, vitals_notes,
//     patient_messages, body, message, reason, diagnosis_label, title
//   plus the singular/plural aliases used by patient portal endpoints.
import sanitizeHtml from 'sanitize-html';

const FREE_TEXT_FIELDS = [
  'notes',
  'advice',
  'allergies',
  'rx_instructions',
  'vitals_notes',
  'patient_messages',
  'body',
  'message',
  'reason',
  'diagnosis_label',
  'title',
  'name',
  'full_name',
];

const DANGEROUS_PATTERNS = [
  /<\s*script\b/i,
  /<\s*\/\s*script\s*>/i,
  /javascript\s*:/i,
  /\bon\w+\s*=/i,           // onclick=, onerror=, onload=, etc.
  /<\s*iframe\b/i,
  /<\s*object\b/i,
  /<\s*embed\b/i,
  /<\s*form\b/i,
  /<\s*input\b/i,
  /<\s*svg\b/i,
  /<\s*math\b/i,
  /data\s*:\s*text\/html/i,
  /vbscript\s*:/i,
];

export const SANITIZE_OPTIONS = {
  allowedTags: ['b', 'i', 'em', 'strong', 'br', 'p', 'ul', 'ol', 'li', 'a'],
  allowedAttributes: {
    a: ['href', 'title', 'rel', 'target'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { a: ['http', 'https', 'mailto'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true),
  },
};

/**
 * Scan a single string for dangerous patterns BEFORE we sanitize.
 * Returns the first matching pattern's index (truthy) or null.
 *
 * @param {string} s
 * @returns {RegExpMatchArray|null}
 */
export function findDangerous(s) {
  if (typeof s !== 'string') return null;
  for (const re of DANGEROUS_PATTERNS) {
    const m = s.match(re);
    if (m) return m;
  }
  return null;
}

/**
 * Sanitize a string value (strip dangerous tags, keep whitelisted).
 *
 * @param {string} s
 * @returns {string}
 */
export function sanitizeValue(s) {
  if (typeof s !== 'string') return s;
  return sanitizeHtml(s, SANITIZE_OPTIONS);
}

/**
 * Recursively walk an object/array and sanitize string values for the
 * given field names. Returns a NEW object — does not mutate the input.
 *
 * @param {object} body — typically req.body
 * @param {string[]} [fields] — field names to sanitize. Defaults to FREE_TEXT_FIELDS.
 * @returns {{ sanitized: object, replaced: string[], rejected: { field: string, match: string }[] }}
 */
export function sanitizeBody(body, fields = FREE_TEXT_FIELDS) {
  const replaced = [];
  const rejected = [];
  const fieldSet = new Set(fields);

  function walk(node, currentKey) {
    if (node == null) return node;
    if (Array.isArray(node)) {
      return node.map(item => walk(item, currentKey));
    }
    if (typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = walk(v, k);
      }
      return out;
    }
    if (typeof node === 'string' && fieldSet.has(currentKey)) {
      // First: reject outright if a known-dangerous pattern is present.
      const danger = findDangerous(node);
      if (danger) {
        rejected.push({ field: currentKey, match: danger[0] });
        // Keep going but mark this field as rejected so the route returns 400.
        return node;
      }
      // Otherwise: normalise through sanitize-html (drops disallowed tags).
      const cleaned = sanitizeValue(node);
      if (cleaned !== node) replaced.push(currentKey);
      return cleaned;
    }
    return node;
  }

  const sanitized = walk(body, null);
  return { sanitized, replaced, rejected };
}

/**
 * Express middleware: sanitize req.body for whitelisted free-text fields.
 * If a dangerous pattern is found in any field, respond 400.
 *
 * Mount AFTER express.json() / urlencoded() body parsers.
 *
 * @param {string[]} [fields] — override FREE_TEXT_FIELDS
 */
export function sanitizeMiddleware(fields) {
  return function (req, res, next) {
    if (!req.body || typeof req.body !== 'object') return next();
    const { sanitized, rejected } = sanitizeBody(req.body, fields);
    if (rejected.length > 0) {
      return res.status(400).json({
        error: 'xss_payload_rejected',
        message: 'Input contains disallowed content (script tag, javascript: URL, event handler, etc.).',
        fields: rejected.map(r => ({ field: r.field, pattern: r.match })),
      });
    }
    req.body = sanitized;
    next();
  };
}

export { FREE_TEXT_FIELDS };
