#!/usr/bin/env node
/**
 * One-shot migration: OB1 `memories` + `vec_memories` -> OB2 `artifacts` (type='note')
 * + `vec_artifacts`. Idempotent and restartable — each memory is its own transaction,
 * keyed by (source='ob1-migration', source_id=<old id>), so re-running only fills gaps.
 *
 * Reuses the existing 1024-dim vectors verbatim (reads the raw float32 blob and re-binds
 * it) — NO re-embedding, so it runs offline and stays bit-for-bit faithful. This is only
 * valid because the embedding model/dimension are unchanged (data-model.md rule 2); do
 * NOT run this across a model swap.
 *
 * The originals are left untouched (append-only). Back up your DB file first
 * (life-context.db by default, or DB_PATH if set).  Run:  npm run migrate
 */
import { db, storeArtifactTxn, sha256, logEvent } from './db.js';

const tableExists = (name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);

function main() {
  if (!tableExists('memories') || !tableExists('vec_memories')) {
    console.log('No OB1 memories/vec_memories tables found — nothing to migrate.');
    return;
  }

  const memories = db.prepare('SELECT id, content, created_at FROM memories ORDER BY id').all();
  const getVec = db.prepare('SELECT embedding FROM vec_memories WHERE memory_id = ?');

  let migrated = 0, skipped = 0, missingVec = 0;
  for (const m of memories) {
    const v = getVec.get(m.id);
    if (!v || !v.embedding) { missingVec++; continue; } // shouldn't happen; guard anyway
    // storeArtifactTxn binds the raw float32 blob directly (a Buffer is a valid vec bind).
    const res = storeArtifactTxn(
      {
        type: 'note',
        source: 'ob1-migration',
        source_id: String(m.id),          // preserves the durable link to the old id
        content_hash: sha256(m.content),
        occurred_at: m.created_at,         // keeps original timestamps (2019 sorts into 2019)
        text_repr: m.content,
      },
      v.embedding
    );
    if (res.deduped) skipped++; else migrated++;
  }

  logEvent('migrate', 'migrate.js', { total: memories.length, migrated, skipped, missingVec });
  console.log(
    `Migration complete: ${migrated} migrated, ${skipped} already present, ` +
    `${missingVec} missing-vector, of ${memories.length} OB1 memories.`
  );
}

main();
db.close();
