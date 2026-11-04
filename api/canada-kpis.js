// POST /api/canada-kpis  (signed in) → Canada KPIs from the Canada Sea Ops database (read only)
//
//   { unbilledRevenue: { amount, jobs }, unpostedCost: { amount, jobs },
//     financialLock: { locked, pending }, operationLock: { locked, pending },
//     totalJobs, dataRefreshedAt, builtAt }
//
// Same rules as the SAR Canada Sea Ops dashboard (its api/mongo-batch.js + index.html):
//   • Unbilled Revenue / Unposted Cost: estimatedvsactual charge lines summed per job (jobNo);
//     a job counts when its sum is > 0, and the amount is the total of those jobs.
//     Cost uses unpostedCost, falling back to the Canada sheet's unbilledCost.
//   • Financial / Operation Lock: jobs in the ca_ops_* job collections that have a lock date
//     (financialLockDate / financialLock, operationLockDate / operationLock); pending = blank.
//
// Environment: CANADA_URI (connection string for the cluster holding sar-ca-ops; a read-only
//              Atlas user is enough), CA_MONGO_DB (default "sar-ca-ops").

import { MongoClient } from "mongodb";
import { authenticate, sendError, HttpError } from "./_auth.js";

const DB_NAME = process.env.CA_MONGO_DB || "sar-ca-ops";
const JOB_COLLECTIONS = ["ca_ops_export", "ca_ops_import", "ca_ops_air_export", "ca_ops_air_import",
                         "ca_ops_road_export", "ca_ops_general"];
const EVA_COLLECTION = "estimatedvsactual";
const TTL_MS = 5 * 60 * 1000;

const g = globalThis;
async function getDb() {
  // Forgive common paste slips: spaces or new lines, surrounding quotes, a leading "CANADA_URI=".
  const MONGO_URI = String(process.env.CANADA_URI || process.env.CA_MONGO_URI || "").trim()
    .replace(/^(CANADA_URI|CA_MONGO_URI)\s*=\s*/, "").replace(/^["']|["']$/g, "").trim();
  if (!MONGO_URI) throw new HttpError(500, "CANADA_URI is not set");
  if (!/^mongodb(\+srv)?:\/\//.test(MONGO_URI)) {
    throw new HttpError(500, `CANADA_URI must start with mongodb+srv:// (it starts with "${MONGO_URI.slice(0, 6)}…").`);
  }
  if (/<\s*(db_)?password\s*>/i.test(MONGO_URI)) throw new HttpError(500, "CANADA_URI still has the <PASSWORD> placeholder: put the real password in its place.");
  if (!g._caMongo) {
    g._caMongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 3 }).connect();
    g._caMongo.catch(() => { g._caMongo = undefined; });
  }
  return (await g._caMongo).db(DB_NAME);
}

const toNum = (v) => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[,\s]/g, "")); return isNaN(n) ? 0 : n; };
const round2 = (n) => Math.round(n * 100) / 100;
const filled = (v) => !(v === undefined || v === null || String(v).trim() === "");

async function amountsFromEva(db) {
  const rows = await db.collection(EVA_COLLECTION)
    .find({}, { projection: { _id: 0, jobNo: 1, unbilledRevenue: 1, unpostedCost: 1, unbilledCost: 1 } }).toArray();
  const byJob = new Map();
  for (const e of rows) {
    const job = String(e.jobNo ?? "").trim();
    if (!job) continue;
    const t = byJob.get(job) || { rev: 0, cost: 0 };
    t.rev  += toNum(e.unbilledRevenue);
    t.cost += toNum(filled(e.unpostedCost) ? e.unpostedCost : e.unbilledCost);
    byJob.set(job, t);
  }
  const out = { unbilledRevenue: { amount: 0, jobs: 0 }, unpostedCost: { amount: 0, jobs: 0 } };
  for (const t of byJob.values()) {
    if (t.rev  > 0) { out.unbilledRevenue.amount += t.rev;  out.unbilledRevenue.jobs++; }
    if (t.cost > 0) { out.unpostedCost.amount    += t.cost; out.unpostedCost.jobs++; }
  }
  out.unbilledRevenue.amount = round2(out.unbilledRevenue.amount);
  out.unpostedCost.amount    = round2(out.unpostedCost.amount);
  return out;
}

async function locksFromJobs(db) {
  const docs = (await Promise.all(JOB_COLLECTIONS.map((name) => db.collection(name)
    .find({}, { projection: { _id: 0, financialLockDate: 1, financialLock: 1, operationLockDate: 1, operationLock: 1, syncedAt: 1 } })
    .toArray()))).flat();
  const out = { totalJobs: docs.length, financialLock: { locked: 0, pending: 0 }, operationLock: { locked: 0, pending: 0 }, jobsSyncedAt: "" };
  for (const d of docs) {
    if (filled(d.financialLockDate) || filled(d.financialLock)) out.financialLock.locked++; else out.financialLock.pending++;
    if (filled(d.operationLockDate) || filled(d.operationLock)) out.operationLock.locked++; else out.operationLock.pending++;
    if (d.syncedAt && String(d.syncedAt) > out.jobsSyncedAt) out.jobsSyncedAt = String(d.syncedAt);
  }
  return out;
}

let cache = { payload: null, at: 0 };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    await authenticate(req);
    const force = !!(req.body && req.body.refresh);
    if (force || !cache.payload || Date.now() - cache.at > TTL_MS) {
      const db = await getDb();
      const [amounts, locks, evaLast] = await Promise.all([
        amountsFromEva(db),
        locksFromJobs(db),
        db.collection(EVA_COLLECTION).find({ syncedAt: { $exists: true } }, { projection: { _id: 0, syncedAt: 1 } })
          .sort({ syncedAt: -1 }).limit(1).toArray(),
      ]);
      const { jobsSyncedAt, ...lockCounts } = locks;
      cache = {
        payload: { ...amounts, ...lockCounts,
                   dataRefreshedAt: { jobs: jobsSyncedAt, estimatedVsActual: evaLast[0] ? String(evaLast[0].syncedAt) : "" },
                   builtAt: new Date().toISOString() },
        at: Date.now(),
      };
    }
    return res.status(200).json(cache.payload);
  } catch (err) {
    return sendError(res, err instanceof HttpError ? err : mongoError(err));
  }
}

// Turns a MongoDB driver error into a message that says what to fix (no secrets in it).
function mongoError(err) {
  console.error("canada-kpis:", err);
  // Mask any user:password@ the driver might echo back
  const m = String(err && err.message || "").replace(/\/\/[^/@\s]*@/g, "//***@");
  const name = String(err && err.name || "");
  if (/authentication failed|bad auth/i.test(m)) return new HttpError(500, "Database sign-in failed: check the user name and password in CANADA_URI.");
  if (/not authorized on|unauthorized/i.test(m)) return new HttpError(500, `The database user in CANADA_URI can't read ${DB_NAME}: give it the read role on ${DB_NAME}.`);
  if (/unescaped characters|must be escaped|percent-encoded/i.test(m)) return new HttpError(500, "The password in CANADA_URI has special characters (@ : / ? # %) that must be URL-encoded, e.g. @ → %40.");
  if (/Server selection timed out|ENOTFOUND|ECONNREFUSED|querySrv|whitelist/i.test(m)) return new HttpError(500, "Can't reach the database: check the cluster address in CANADA_URI and that Atlas Network Access allows Vercel (0.0.0.0/0).");
  if (name === "MongoParseError" || name === "MongoAPIError") return new HttpError(500, "CANADA_URI can't be read: " + m.slice(0, 200));
  return new HttpError(500, "Database error: " + m.slice(0, 200));
}
