// The slice of the Admin SDK's Firestore the bridge uses, in memory.
export function fakeFirestore(initial = {}) {
  const docs = new Map(Object.entries(initial));   // 'a/b/c/d' -> data
  const clone = d => JSON.parse(JSON.stringify(d));
  const docRef = path => ({
    id: path.split('/').pop(),
    path,
    collection: name => colRef(path + '/' + name),
    get: async () => ({ id: path.split('/').pop(), exists: docs.has(path), data: () => (docs.has(path) ? clone(docs.get(path)) : undefined) }),
    set: async data => { docs.set(path, clone(data)); },
    update: async patch => {
      if (!docs.has(path)) throw new Error('NOT_FOUND: ' + path);
      docs.set(path, Object.assign(clone(docs.get(path)), clone(patch)));
    },
    delete: async () => { docs.delete(path); }
  });
  const colRef = path => ({
    path,
    doc: id => docRef(path + '/' + id),
    get: async () => {
      const hits = [...docs.keys()].filter(p => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/'));
      const list = hits.map(p => ({ id: p.split('/').pop(), data: () => clone(docs.get(p)) }));
      return { docs: list, size: list.length, empty: !list.length, forEach: f => list.forEach(f) };
    }
  });
  return { docs, collection: name => colRef(name) };
}
