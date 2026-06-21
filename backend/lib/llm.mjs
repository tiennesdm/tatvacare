// LLM wrapper — OpenAI API + graceful fallback.
// When OPENAI_API_KEY is set, calls the API. Otherwise returns a deterministic
// rule-based response so demos work without keys.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '25000');

let _enabled = !!OPENAI_API_KEY;
function isEnabled() { return _enabled; }

async function llmComplete({ system, user, json = false, temperature = 0.2, maxTokens = 800 }) {
  if (!_enabled) {
    throw new Error('LLM not configured (set OPENAI_API_KEY env var)');
  }
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const body = {
      model: OPENAI_MODEL,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
      temperature,
      max_tokens: maxTokens,
    };
    if (json) body.response_format = { type: 'json_object' };
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`OpenAI ${r.status}: ${t.slice(0, 200)}`);
    }
    const j = await r.json();
    return {
      text: j.choices?.[0]?.message?.content || '',
      usage: {
        prompt_tokens: j.usage?.prompt_tokens || 0,
        completion_tokens: j.usage?.completion_tokens || 0,
        total_tokens: j.usage?.total_tokens || 0,
      },
      model: j.model || OPENAI_MODEL,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Track usage to llm_usage table
async function logUsage(pool, { feature, patient_id, doctor_id, usage, model, latency_ms, status, error }) {
  if (!pool) return;
  const usage_id = 'u-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const cols = ['usage_id', 'ts', 'feature', 'patient_id', 'doctor_id', 'model', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'latency_ms', 'status', 'error'];
  const fields = [
    usage_id, ts, feature || '', patient_id || '', doctor_id || '', model || '',
    usage?.prompt_tokens || 0, usage?.completion_tokens || 0, usage?.total_tokens || 0,
    latency_ms || 0, status || 'ok', (error || '').slice(0, 1000),
  ];
  const q = `INSERT INTO llm_usage (${cols.join(', ')}) VALUES (${fields.map((f, i) => {
    if (cols[i] === 'ts') return `'${f}'`;
    if (typeof f === 'number') return String(f);
    return `'${String(f).replace(/'/g, "''")}'`;
  }).join(', ')})`;
  try { await pool.query(q); } catch (e) { /* ignore */ }
}

// Format patient context for LLM prompts
function formatPatientContext(patient, problems, currentMeds, recentVitals) {
  const lines = [];
  if (patient) lines.push(`Patient: ${patient.full_name}, age ${patient.age_years || '?'}, ${patient.gender || '?'}, phone ${patient.phone || '?'}`);
  if (problems?.length) lines.push(`Active problems: ${problems.map(p => p.problem_name).join(', ')}`);
  if (currentMeds?.length) lines.push(`Current meds: ${currentMeds.map(m => `${m.drug_name} ${m.dose || ''}`).join('; ')}`);
  if (recentVitals?.length) {
    const vit = recentVitals.map(v => `${v.metric_name}: ${v.value}`).join(', ');
    lines.push(`Recent vitals: ${vit}`);
  }
  return lines.join('\n');
}

export { llmComplete, logUsage, isEnabled, formatPatientContext, OPENAI_MODEL };
