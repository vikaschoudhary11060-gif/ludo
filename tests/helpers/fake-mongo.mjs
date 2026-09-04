/* ============================================================
   A tiny in-memory stand-in for the MongoDB collection API.

   Implements only what the wallet primitives use — enough to
   exercise credit()/debit() for real, including the conditional
   update filters that make them safe under concurrency.
   ============================================================ */

const matches = (doc, filter) => Object.entries(filter).every(([key, cond]) => {
  /* Logical operators take a list of sub-filters rather than a field
     condition, so they have to be handled before `doc[key]` is read — `$or`
     was previously treated as a field name, which quietly matched nothing and
     made every $or query look like an empty collection. */
  if (key === '$or')  return cond.some(c => matches(doc, c));
  if (key === '$and') return cond.every(c => matches(doc, c));
  if (key === '$nor') return !cond.some(c => matches(doc, c));

  const v = doc[key];
  /* A bare RegExp is a field condition in its own right — `{ name: /anita/i }`
     — and has to be caught before the operator loop below. A RegExp has no own
     enumerable properties, so falling through to `Object.entries(cond).every()`
     matched *every* document: an admin search test would pass whether or not
     the route filtered anything at all. */
  if (cond instanceof RegExp) return typeof v === 'string' && cond.test(v);
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
      case '$nin': return !operand.includes(v);
      case '$ne':  return v !== operand;
      case '$exists': return (v !== undefined) === !!operand;
      case '$regex': {
        const rx = operand instanceof RegExp ? operand : new RegExp(operand, cond.$options || '');
        return typeof v === 'string' && rx.test(v);
      }
      // Consumed by $regex above; on its own it constrains nothing.
      case '$options': return true;
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


/* A very small expression evaluator — only the operators the tested
   pipelines use. Anything else throws, for the same reason as the stages. */
function evalExpr(expr, doc) {
  if (typeof expr === 'string' && expr.startsWith('$')) {
    /* Mongo maps a dotted path across an array rather than indexing into it,
       which is what makes `$c.name` after a $lookup an array of names — the
       exact shape $arrayElemAt is then used on. */
    return expr.slice(1).split('.').reduce((v, k) => {
      if (v == null) return undefined;
      if (Array.isArray(v)) return v.map(e => (e == null ? undefined : e[k]));
      return v[k];
    }, doc);
  }
  if (expr === null || typeof expr !== 'object' || Array.isArray(expr)) return expr;
  const [op, arg] = Object.entries(expr)[0];
  switch (op) {
    case '$arrayElemAt': { const a = evalExpr(arg[0], doc); return Array.isArray(a) ? a[arg[1]] : undefined; }
    case '$ifNull': { const v = evalExpr(arg[0], doc); return v == null ? evalExpr(arg[1], doc) : v; }
    case '$multiply': return arg.reduce((n, e) => n * (Number(evalExpr(e, doc)) || 0), 1);
    case '$subtract': return (Number(evalExpr(arg[0], doc)) || 0) - (Number(evalExpr(arg[1], doc)) || 0);
    case '$eq': return evalExpr(arg[0], doc) === evalExpr(arg[1], doc);
    case '$cond': return evalExpr(arg[0], doc) ? evalExpr(arg[1], doc) : evalExpr(arg[2], doc);
    default: throw new Error('fake-mongo: unsupported expression ' + op);
  }
}

const evalFields = (spec, doc) =>
  Object.fromEntries(Object.entries(spec).map(([k, e]) => [k, evalExpr(e, doc)]));

function project(doc, spec) {
  const entries = Object.entries(spec);
  // Mongo forbids mixing include and exclude, apart from _id — so do we.
  const including = entries.some(([k, v]) => v === 1 && k !== '_id');
  if (!including) {
    const out = { ...doc };
    for (const [k, v] of entries) if (v === 0) delete out[k];
    return out;
  }
  const out = {};
  for (const [k, v] of entries) {
    if (v === 0) continue;
    out[k] = v === 1 ? doc[k] : evalExpr(v, doc);
  }
  if (spec._id !== 0 && '_id' in doc) out._id = doc._id;
  return out;
}

function group(rows, spec) {
  const { _id: idExpr, ...accs } = spec;
  const buckets = new Map();
  for (const doc of rows) {
    const id = evalExpr(idExpr, doc);
    const key = JSON.stringify(id ?? null);
    if (!buckets.has(key)) buckets.set(key, { _id: id === undefined ? null : id, rows: [] });
    buckets.get(key).rows.push(doc);
  }
  return [...buckets.values()].map(({ _id, rows: group }) => {
    const out = { _id };
    for (const [field, acc] of Object.entries(accs)) {
      const [op, arg] = Object.entries(acc)[0];
      if (op === '$sum') out[field] = group.reduce((n, d) => n + (Number(evalExpr(arg, d)) || 0), 0);
      else if (op === '$addToSet') out[field] = [...new Set(group.map(d => evalExpr(arg, d)))];
      else throw new Error('fake-mongo: unsupported accumulator ' + op);
    }
    return out;
  });
}

class FakeCollection {
  constructor(name, db) { this.name = name; this.docs = []; this._db = db; }

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

  async deleteMany(filter = {}) {
    const before = this.docs.length;
    this.docs = this.docs.filter(d => !matches(d, filter));
    return { acknowledged: true, deletedCount: before - this.docs.length };
  }

  async deleteOne(filter = {}) {
    const i = this.docs.findIndex(d => matches(d, filter));
    if (i < 0) return { acknowledged: true, deletedCount: 0 };
    this.docs.splice(i, 1);
    return { acknowledged: true, deletedCount: 1 };
  }

  async createIndex() { return 'ok'; }

  /* Enough of the aggregation pipeline for the routes under test, and no
     more: an unknown stage throws rather than being skipped, so a query this
     stand-in cannot actually run fails the test instead of quietly returning
     the wrong rows. */
  aggregate(stages = []) {
    const self = this;
    return {
      toArray: async () => {
        let rows = self.docs.map(d => ({ ...d }));
        for (const stage of stages) {
          const [op, spec] = Object.entries(stage)[0];
          switch (op) {
            case '$match': rows = rows.filter(d => matches(d, spec)); break;
            case '$limit': rows = rows.slice(0, spec); break;
            case '$sort': {
              const keys = Object.entries(spec);
              rows = [...rows].sort((a, b) => {
                for (const [k, dir] of keys) {
                  if (a[k] === b[k]) continue;
                  if (a[k] === undefined) return dir >= 0 ? -1 : 1;
                  if (b[k] === undefined) return dir >= 0 ? 1 : -1;
                  return (a[k] < b[k] ? -1 : 1) * (dir >= 0 ? 1 : -1);
                }
                return 0;
              });
              break;
            }
            case '$lookup': {
              const { from, localField, foreignField, as } = spec;
              const src = self._db(from).docs;
              rows = rows.map(d => ({ ...d, [as]: src.filter(x => x[foreignField] === d[localField]).map(x => ({ ...x })) }));
              break;
            }
            case '$addFields': rows = rows.map(d => ({ ...d, ...evalFields(spec, d) })); break;
            case '$project': rows = rows.map(d => project(d, spec)); break;
            case '$group': rows = group(rows, spec); break;
            default: throw new Error('fake-mongo: unsupported aggregation stage ' + op);
          }
        }
        return rows;
      },
    };
  }

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
    if (!collections.has(name)) collections.set(name, new FakeCollection(name, col));
    return collections.get(name);
  };
  /* One sequence per collection, exactly like the counters collection the
     real nextId() drives — a single shared counter made ids depend on how
     many unrelated rows a test happened to create first. */
  const counters = new Map();
  return {
    col,
    nextId: async name => {
      const next = (counters.get(name) || 0) + 1;
      counters.set(name, next);
      return next;
    },
    /* No isolation — deliberately. Running the callback straight through is
       the pessimistic case: it proves the guards hold on their own rather
       than leaning on the database to serialise anything. */
    withTransaction: async fn => fn(null),
    connect: async () => {},
    reset: () => { collections.clear(); counters.clear(); },
    dump: name => col(name).docs,
  };
}
