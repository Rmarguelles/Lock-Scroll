// Firestore access for the bridge: who an access link belongs to, and the
// snapshot the app published for that user. The bridge runs with the
// project's own service account, so Firestore rules do not apply to it; what
// it may touch is decided here.
import { createHash } from 'node:crypto';

const TOKEN_CACHE_MS = 60 * 1000;
const SNAPSHOT_CACHE_MS = 60 * 1000;
const LAST_USED_EVERY_MS = 60 * 60 * 1000;

const tokenCache = new Map();     // hash -> { at, value }
const snapshotCache = new Map();  // uid -> { at, value }

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

// The access link's owner and rights, or null. Only the SHA-256 hash of a
// token is stored (agentTokens/<hash>), written by the app when the link was
// made; deleting that document revokes the link.
export async function authenticate(db, token) {
  if (!token || !/^lsa_[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const hash = hashToken(token);
  const hit = tokenCache.get(hash);
  if (hit && Date.now() - hit.at < TOKEN_CACHE_MS) return hit.value;
  const doc = await db.collection('agentTokens').doc(hash).get();
  const data = doc.exists ? doc.data() : null;
  const value = data && data.uid ? { hash, uid: data.uid, name: data.name || 'Agent', canWrite: !!data.canWrite, lastUsedAt: data.lastUsedAt || null } : null;
  tokenCache.set(hash, { at: Date.now(), value });
  if (value && (!value.lastUsedAt || Date.now() - Date.parse(value.lastUsedAt) > LAST_USED_EVERY_MS)) {
    value.lastUsedAt = new Date().toISOString();
    // Shown in the app next to the link. Never worth failing a request over.
    db.collection('agentTokens').doc(hash).update({ lastUsedAt: value.lastUsedAt }).catch(() => {});
  }
  return value;
}

// The snapshot the app published for this user (users/<uid>/agent/view, split
// into parts view, view__2 ...), put back together. Every part must be there
// and come from the same publish; otherwise it is not used.
export async function loadSnapshot(db, uid) {
  const hit = snapshotCache.get(uid);
  if (hit && Date.now() - hit.at < SNAPSHOT_CACHE_MS) return hit.value;
  const qs = await db.collection('users').doc(uid).collection('agent').get();
  const parts = [];
  qs.forEach(d => {
    const m = /^view(?:__(\d+))?$/.exec(d.id);
    if (m) parts[m[1] ? parseInt(m[1], 10) - 1 : 0] = d.data();
  });
  const first = parts[0];
  if (!first) return { missing: true };
  const n = first.parts || 1;
  const pieces = [];
  for (let i = 0; i < n; i++) {
    const p = parts[i];   // a plain loop: .some() would skip a missing part
    if (!p || typeof p.json !== 'string' || p.builtAt !== first.builtAt) {
      return { error: 'The saved data is incomplete (an update may be in progress). Try again in a moment.' };
    }
    pieces.push(p);
  }
  let snap;
  try {
    snap = JSON.parse(pieces.map(p => p.json).join(''));
  } catch (e) {
    return { error: 'The saved data could not be read.' };
  }
  const value = { snap, meta: { builtAt: first.builtAt, schema: first.schema || null } };
  snapshotCache.set(uid, { at: Date.now(), value });
  return value;
}
