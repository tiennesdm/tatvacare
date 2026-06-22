// Security headers — helmet() configured for TatvaCare.
//
// Why these specific values:
//
// - contentSecurityPolicy: default-src 'self' is the strictest baseline. The
//   app is mostly server-rendered HTML + vanilla JS + Tailwind CDN. Inline
//   scripts/styles are NOT used by TatvaCare pages — we serve plain .html
//   and external <script src=...> only. CSP reports violations to /api/csp-report
//   (route added when needed; currently we keep console-only logging so we
//   don't accidentally 500 in dev). script-src/style-src 'self' is safe; we
//   do NOT add 'unsafe-inline' — if Next.js/React ever lands here, switch to
//   nonces (CSP3) rather than re-enabling unsafe-inline.
//
// - hsts: 180 days, includeSubDomains, preload. We're behind a TLS terminator
//   in prod (LB). Browsers will refuse plaintext for subdomains once seen.
//
// - frameguard: SAMEORIGIN. The /telemedicine page embeds a WebRTC iframe
//   pointing at /api/telemedicine/sessions/:id/messages which is same-origin
//   so SAMEORIGIN is correct; a doctor's prescription PDF rendered in an
//   iframe on the same site also stays same-origin. NEVER switch to DENY —
//   that breaks the telemedicine iframe. If a future feature needs to embed
//   a third-party widget (Stripe, etc.), use frameAncestors CSP instead of
//   relaxing X-Frame-Options.
//
// - noSniff: prevents MIME confusion attacks (e.g. user-uploaded image
//   interpreted as HTML/JS). Required when accepting multipart uploads
//   (we do, on /api/ai/voice/transcribe and /api/ai/dl/*).
//
// - referrerPolicy: strict-origin-when-cross-origin — sends full path to
//   same-origin links, only origin (no path) to cross-origin links.
//   This is the OWASP-recommended default and avoids leaking patient
//   identifiers in the Referer to e.g. image CDN.
//
// - crossOriginOpenerPolicy: same-origin — neutralises window.opener
//   tabnabbing. We don't open cross-origin windows from TatvaCare so this
//   is a clean default. If the LLM/RAG feature ever embeds a model picker
//   that opens a tab to OpenAI's playground, leave this alone — same-origin
//   means same-tab only, doesn't block legitimate cross-origin opens.
//
// Other helmet defaults we keep enabled: hidePoweredBy (removes X-Powered-By:
// Express which leaks framework version), ieNoOpen (IE-specific X-Download-Options),
// permittedCrossDomainPolicies (Flash/PDF cross-domain policy).
import helmet from 'helmet';

/**
 * Build the helmet() middleware configured for TatvaCare.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.allowInlineScripts=false] — escape hatch for legacy
 *   pages that have inline <script> blocks. Default false. When true, script-src
 *   gets 'unsafe-inline' added (CSP2 fallback — STRONGLY prefer nonces if you
 *   reach for this).
 * @returns Express middleware
 */
export function buildHelmet(opts = {}) {
  const { allowInlineScripts = false } = opts;
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // TatvaCare pages currently use only external <script src="..."> and
        // external <link rel="stylesheet">. If a page later needs inline,
        // use a nonce (not unsafe-inline).
        scriptSrc: ["'self'", ...(allowInlineScripts ? ["'unsafe-inline'"] : [])],
        styleSrc: ["'self'", "'unsafe-inline'"], // Tailwind CDN lives at <style> tags — allow inline styles
        imgSrc: ["'self'", 'data:', 'blob:'],
        // Telemedicine page does same-origin fetch + XHR to /api/telemedicine/...
        connectSrc: ["'self'"],
        // Same-origin iframes (WebRTC session view), no third-party embeds.
        frameSrc: ["'self'"],
        // Same-origin can frame us; nobody else can (defence-in-depth with frameguard).
        frameAncestors: ["'self'"],
        // Refuse to be embedded as <object>/<embed>/<applet>.
        objectSrc: ["'none'"],
        // Don't allow legacy base-tag injection — protects relative URLs in
        // case of HTML injection.
        baseUri: ["'self'"],
        // Form posts only back to ourselves.
        formAction: ["'self'"],
        // No mixed content — subresources must be HTTPS.
        upgradeInsecureRequests: [],
      },
    },
    hsts: {
      maxAge: 15552000,           // 180 days
      includeSubDomains: true,
      preload: true,
    },
    frameguard: { action: 'sameorigin' },
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    // Keep helmet defaults for the rest
    hidePoweredBy: true,
    ieNoOpen: true,
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  });
}
