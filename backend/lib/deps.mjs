// RAG knowledge base helpers (queries the kb_documents table via VBP).
export const clinical = {
  async getKBDocuments(pool) {
    const r = await pool.query('SELECT doc_id, source, title, body, tags, url FROM kb_documents');
    return r.rows.map(row => ({
      doc_id: row[0], source: row[1], title: row[2], body: row[3], tags: row[4] || '', url: row[5] || '',
    }));
  },
  async searchKB(pool, query) {
    const docs = await this.getKBDocuments(pool);
    const q = query.toLowerCase();
    return docs.filter(d =>
      d.title.toLowerCase().includes(q) ||
      d.body.toLowerCase().includes(q) ||
      (d.tags || '').toLowerCase().includes(q)
    );
  },
};
