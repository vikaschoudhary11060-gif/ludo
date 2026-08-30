/* ============================================================
   A tiny in-memory stand-in for the MongoDB collection API.

   Implements only what the wallet primitives use — enough to
   exercise credit()/debit() for real, including the conditional
   update filters that make them safe under concurrency.
   ============================================================ */

const matches = (doc, filter) => Object.entries(filter).every(([key, cond]) => {
  const v = doc[key];
  if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) return v === cond;
  return Object.entries(cond).every(([op, operand]) => {
    switch (op) {
      // A missing field must not satisfy a comparison — this is the exact
      // MongoDB behaviour the debit() guards depend on.
      case '$gte': return typeof v === 'number' && v >= operand;
      case '$gt':  return typeof v === 'number' && v > operand;
      case '$lte': return typeof v === 'number' && v <= operand;
      case '$lt':  return typeof v === 'number' && v < operand;
      case '$in':  return operand.includes(v);
      case '$ne':  return v !== operand;
      default: throw new Error('fake-mongo: unsupported operator ' + op);
    }
  });
});

function applyUpdate(doc, update, inserted) {
  for (const [op, fields] of Object.entries(update)) {
    if (op === '$inc') for (const [k, n] of Object.entries(fields)) doc[k] = (doc[k] || 0) + n;
    else if (op === '$set') Object.assign(doc, fields);
    else if (op === '$unset') for (const k of Object.keys(fields)) delete doc[k];
    else if (op === '$setOnInsert') { if (inserted) for (const [k, v] of Object.entries(fields)) if (doc[k] === undefined) doc[k] = v; }
    else throw new Error('fake-mongo: unsupported update ' + op);
  }
  return doc;
}

class FakeCollection {
  constructor(name) { this.name = name; this.docs = []; }

  async findOne(filter, _opts) {
    const hit = this.docs.find(d => matches(d, filter));
    // A copy, exactly as the driver returns — otherwise callers would observe
    // later writes through a live reference and stale reads could never happen.
    return hit ? { ...hit } : null;
  }

  async insertOne(doc, _opts) {
    this.docs.push({ ...doc });
    return { acknowledged: true };
  }

  async updateOne(filter, update, opts = {}) {
    const hit = this.docs.find(d => matches(d, filter));
    if (hit) { applyUpdate(hit, update, false); return { matchedCount: 1, modifiedCount: 1 }; }
    if (opts.upsert) {
      const seed = {};
      // An upsert seeds equality terms from the filter, as MongoDB does.
      for (const [k, v] of Object.entries(filter)) if (typeof v !== 'object' || v === null) seed[k] = v;
      const doc = applyUpdate(seed, update, true);
      this.docs.push(doc);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }
    return { matchedCount: 0, modifiedCount: 0 };
  }

  async findOneAndUpdate(filter, update, opts = {}) {
    const hit = this.docs.find(d => matches(d, filter));
    if (!hit) return null;
    const before = { ...hit };
    applyUpdate(hit, update, false);
    return opts.returnDocument === 'before' ? before : { ...hit };
  }

  async countDocuments(filter = {}) { return this.docs.filter(d => matches(d, filter)).length; }

  find(filter = {}) {
    let out = this.docs.filter(d => matches(d, filter));
    const cursor = {
      /* Honour the sort rather than ignoring it: a no-op here would let a
         query that depends on ordering pass whether or not the clause is
         present, which is exactly the class of bug these tests exist for. */
      sort: (spec = {}) => {
        const keys = Object.entries(spec);
        if (!keys.length) return cursor;
        out = [...out].sort((a, b) => {
          for (const [k, dir] of keys) {
            const av = a[k], bv = b[k];
            if (av === bv) continue;
            // Undefined sorts before any value, as MongoDB orders missing fields.
            if (av === undefined) return dir >= 0 ? -1 : 1;
            if (bv === undefined) return dir >= 0 ? 1 : -1;
            return (av < bv ? -1 : 1) * (dir >= 0 ? 1 : -1);
          }
          return 0;
        });
        return cursor;
      },
      limit: n => { out = out.slice(0, n); return cursor; },
      toArray: async () => out.map(d => ({ ...d })),
    };
    return cursor;
  }
}

export function createFakeDb() {
  const collections = new Map();
  const col = name => {
    if (!collections.has(name)) collections.set(name, new FakeCollection(name));
    return collections.get(name);
  };
  let counter = 0;
  return {
    col,
    nextId: async () => ++counter,
    /* No isolation — deliberately. Running the callback straight through is
       the pessimistic case: it proves the guards hold on their own rather
       than leaning on the database to serialise anything. */
    withTransaction: async fn => fn(null),
    connect: async () => {},
    reset: () => collections.clear(),
    dump: name => col(name).docs,
  };
}
