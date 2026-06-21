// RAG over clinical guidelines — simple TF-IDF keyword retrieval.
// No embeddings API needed; works offline.
// For production: swap for proper vector embeddings (OpenAI, Cohere, etc.)

import { clinical } from './deps.mjs';

let _index = null;

async function buildIndex(pool) {
  const docs = await clinical.getKBDocuments(pool);
  const index = docs.map(d => {
    const tokens = tokenize(d.body + ' ' + d.title + ' ' + d.tags);
    const tf = termFreq(tokens);
    return { doc: d, tokens, tf };
  });
  // IDF
  const N = index.length;
  const df = {};
  for (const item of index) {
    for (const term of new Set(item.tokens)) {
      df[term] = (df[term] || 0) + 1;
    }
  }
  const idf = {};
  for (const term of Object.keys(df)) {
    idf[term] = Math.log((N + 1) / (df[term] + 1)) + 1;
  }
  _index = { items: index, idf, N };
}

function tokenize(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function termFreq(tokens) {
  const f = {};
  for (const t of tokens) f[t] = (f[t] || 0) + 1;
  return f;
}

function vectorize(tf, idf) {
  const v = {};
  for (const [t, c] of Object.entries(tf)) {
    if (idf[t]) v[t] = c * idf[t];
  }
  return v;
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const k of Object.keys(a)) {
    if (b[k]) dot += a[k] * b[k];
    na += a[k] * a[k];
  }
  for (const k of Object.keys(b)) nb += b[k] * b[k];
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function retrieve(pool, query, topK = 3) {
  if (!_index) await buildIndex(pool);
  const queryTokens = tokenize(query);
  const queryTf = termFreq(queryTokens);
  const queryVec = vectorize(queryTf, _index.idf);
  const scored = _index.items.map(item => ({
    score: cosineSim(queryVec, vectorize(item.tf, _index.idf)),
    doc: item.doc,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter(s => s.score > 0);
}

async function augmentPrompt(pool, query, topK = 3) {
  const hits = await retrieve(pool, query, topK);
  if (!hits.length) return { context: '', citations: [] };
  const context = hits.map((h, i) =>
    `[${i + 1}] ${h.doc.source}: ${h.doc.title}\n${h.doc.body}`
  ).join('\n\n');
  return {
    context,
    citations: hits.map(h => ({ source: h.doc.source, title: h.doc.title, url: h.doc.url, score: h.score.toFixed(3) })),
  };
}

export { buildIndex, retrieve, augmentPrompt };
