// SAR Internal Audit Dashboard — data API (Vercel serverless function), read only.
//
//   POST /api/mongo-batch  { dataset: "canada" | "usa" | "indonesia" | "thailand", refresh? }  (signed in) -> per-job rows
//     { jobs:    { fields: [jobNo, direction, lob, branch, jobOwner, periodDate, open, finPending, opsPending], rows },
//       evaJobs: { fields: [jobNo, direction, lob, branch, jobOwner, periodDate, unbilledRevenue, unpostedCost,
//                           revFlag, costFlag], rows },   revFlag / costFlag: counted in Revenue Not Billed / Cost Not Posted
//       dataRefreshedAt: { jobs, estimatedVsActual }, builtAt }
//     The KPI cards and the Branch › Job Owner table are worked out from these rows in the page.
//     refresh: true skips the 5-minute cache.
//   POST /api/mongo-batch  { dataset: "jobDetails",  entity, jobNos }       -> { rows }  job records for a pop-up
//   POST /api/mongo-batch  { dataset: "chargeLines", entity, jobNos, kind } -> { rows }  kind "rev" | "cost": charge lines > 0
//
// SAR Canada — same rules as the SAR Canada Sea Ops dashboard (database sar-ca-ops):
//   • Unbilled Revenue / Unposted Cost: estimatedvsactual charge lines summed per job (jobNo); a job
//     counts when its sum is > 0. Jobs with no direction are left out. Cost uses unpostedCost,
//     falling back to the Canada sheet's unbilledCost. Amounts are in CAD.
//   • Jobs: the ca_ops_* collections. Open = isOpen, else no Operation Lock Date.
// SAR USA — same rules as the SAR USA Sea Ops dashboard (database sar-usa-ops):
//   • Unbilled Revenue / Unposted Cost: usa_ops_etdeta charge lines of Sea / Air / Road Export and
//     Import (lobExportImport), summed per shipment; period = ETD/ETA New. Amounts are in USD.
//   • Jobs: usa_ops_jobs (every LOB). Period = ETD/ETA New › Job Date. Open = no Operation Lock Date.
// SAR Indonesia — same rules as the SAR Indonesia Sea Ops dashboard (database sar-id-ops):
//   • Jobs: th_ops_export, th_ops_import and id_ops_crosstrade. Direction from the LOB code (FES, FIA…);
//     period = ETA (Import) or ETD, else Job Opened. Open = status not CMP / CLS and ETD (ETA for
//     Import) more than 7 days ago.
//   • Revenue Not Billed: the job has WIP lines with WIP > 0 and its ETD / ETA is more than 3 days
//     ago; amount = those lines' WIP. Cost Not Posted: accrual lines ≠ 0 and ETD / ETA more than
//     7 days ago; amount = their accrual. WIP lines are in th_ops_wip. Amounts are in IDR.
// SAR Thailand — the SAR Thailand Sea Ops dashboard has the same rules as Indonesia (database
//   sar-th-ops; cross trade in th_ops_crosstrade). Amounts are in THB.
// All: Financial / Operation Lock Pending = the job has no lock date.
//
// Environment: CANADA_URI (cluster holding sar-ca-ops), USA_URI (sar-usa-ops), INDONESIA_URI
// (sar-id-ops), THAILAND_URI (sar-th-ops); the others fall back to CANADA_URI when they are on the
// same cluster. CA_ / USA_ / ID_ / TH_MONGO_DB rename the databases. A read-only Atlas user is enough.

import { MongoClient } from "mongodb";
import { authenticate, sendError, HttpError } from "./mongo.js";

const ENTITIES = {
  canada: { envs: ["CANADA_URI", "CA_MONGO_URI"], db: process.env.CA_MONGO_DB || "sar-ca-ops" },
  usa:    { envs: ["USA_URI", "CANADA_URI", "CA_MONGO_URI"], db: process.env.USA_MONGO_DB || "sar-usa-ops" },
  indonesia: { envs: ["INDONESIA_URI", "CANADA_URI", "CA_MONGO_URI"], db: process.env.ID_MONGO_DB || "sar-id-ops" },
  thailand:  { envs: ["THAILAND_URI", "CANADA_URI", "CA_MONGO_URI"], db: process.env.TH_MONGO_DB || "sar-th-ops" },
};
const TTL_MS = 5 * 60 * 1000;

const g = globalThis;
g._auditMongo = g._auditMongo || new Map();   // connection string -> connecting client

function entityOf(name) {
  const e = ENTITIES[name];
  if (!e) throw new HttpError(400, "Unknown company");
  return e;
}

async function getDb(entity) {
  const e = entityOf(entity);
  const envName = e.envs.find((n) => process.env[n]) || e.envs[0];
  // Forgive common paste slips: spaces or new lines, surrounding quotes, a leading "NAME=".
  const uri = String(process.env[envName] || "").trim()
    .replace(/^[A-Z_]+\s*=\s*/, "").replace(/^["']|["']$/g, "").trim();
  if (!uri) throw new HttpError(500, `${e.envs[0]} is not set`);
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    throw new HttpError(500, `${envName} must start with mongodb+srv:// (it starts with "${uri.slice(0, 6)}…").`);
  }
  if (/<\s*(db_)?password\s*>/i.test(uri)) throw new HttpError(500, `${envName} still has the <PASSWORD> placeholder: put the real password in its place.`);
  if (!g._auditMongo.has(uri)) {
    const p = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 3 }).connect();
    p.catch(() => g._auditMongo.delete(uri));
    g._auditMongo.set(uri, p);
  }
  try {
    return (await g._auditMongo.get(uri)).db(e.db);
  } catch (err) {
    throw mongoError(err, envName, e.db);
  }
}

const toNum = (v) => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[,\s]/g, "")); return isNaN(n) ? 0 : n; };
const round2 = (n) => Math.round(n * 100) / 100;
const filled = (v) => !(v === undefined || v === null || String(v).trim() === "");
const projectionOf = (fields) => Object.fromEntries([["_id", 0], ...fields.map((f) => [f, 1])]);

const JOB_FIELDS = ["jobNo", "direction", "lob", "branch", "jobOwner", "periodDate", "open", "finPending", "opsPending"];
const EVA_JOB_FIELDS = ["jobNo", "direction", "lob", "branch", "jobOwner", "periodDate", "unbilledRevenue", "unpostedCost",
                        "revFlag", "costFlag"];
// Canada / USA: a job counts when its summed amount is > 0
const evaRow = (base, rev, cost) => [...base, round2(rev), round2(cost), round2(rev) > 0, round2(cost) > 0];
const finPendingOf = (d) => !(filled(d.financialLockDate) || filled(d.financialLock));
const opsPendingOf = (d) => !(filled(d.operationLockDate) || filled(d.operationLock));

// ---------------------------------------------------------------- SAR Canada (sar-ca-ops)

const CA_JOB_COLLECTIONS = ["ca_ops_export", "ca_ops_import", "ca_ops_air_export", "ca_ops_air_import",
                            "ca_ops_road_export", "ca_ops_general"];
const CA_EVA = "estimatedvsactual";
const evaDirection = (lob) => { const u = String(lob || "").toUpperCase(); return /^GEN/.test(u) ? "General" : /EXP/.test(u) ? "Export" : /IMP/.test(u) ? "Import" : ""; };

// One row per estimatedvsactual job, as the Canada dashboard builds them (evaJobSummaries in its
// mongo-batch.js): jobs without a direction are left out, and the period date is Job Date for
// General jobs, otherwise ETD/ETA New › ETD/ETA › Job Date.
async function canadaEvaJobs(db) {
  const rows = await db.collection(CA_EVA)
    .find({}, { projection: { _id: 0, jobNo: 1, unbilledRevenue: 1, unpostedCost: 1, unbilledCost: 1, lob: 1, lob2: 1, direction: 1,
                              etdEtaNew: 1, etdEta: 1, jobDate: 1, location: 1, jobOwner: 1, salesPerson: 1 } }).toArray();
  const byJob = new Map();
  for (const e of rows) {
    const job = String(e.jobNo ?? "").trim();
    if (!job) continue;
    let t = byJob.get(job);
    if (!t) {
      t = { rev: 0, cost: 0, lob2: e.lob2 || "", direction: e.direction || evaDirection(e.lob2 || e.lob),
            etdEtaNew: e.etdEtaNew || "", etdEta: e.etdEta || "", jobDate: e.jobDate || "",
            location: e.location || "", jobOwner: e.jobOwner || "", salesPerson: e.salesPerson || "" };
      byJob.set(job, t);
    }
    t.rev  += toNum(e.unbilledRevenue);
    t.cost += toNum(filled(e.unpostedCost) ? e.unpostedCost : e.unbilledCost);
  }
  const out = { fields: EVA_JOB_FIELDS, rows: [] };
  for (const [job, t] of byJob) {
    if (!t.direction) continue;
    out.rows.push(evaRow([
      job, t.direction, t.lob2 || (t.direction === "General" ? "GEN" : "SEA " + t.direction.toUpperCase()),
      t.location || "(No Branch)", t.jobOwner || t.salesPerson || "(Unknown)",
      t.direction === "General" ? (t.jobDate || t.etdEtaNew || t.etdEta) : (t.etdEtaNew || t.etdEta || t.jobDate),
    ], t.rev, t.cost));
  }
  return out;
}

// One row per job in the ca_ops_* collections. Same fields the Canada dashboard uses: branch =
// jobBranch › branch › location, owner = operator › jobOwner, period = periodDate › jobDate,
// open = isOpen (else no Operation Lock Date). Direction and LOB fall back to the collection.
const CA_COLLECTION_LOB = { ca_ops_export: ["Export", "SEA EXPORT"], ca_ops_import: ["Import", "SEA IMPORT"],
                            ca_ops_air_export: ["Export", "AIR EXPORT"], ca_ops_air_import: ["Import", "AIR IMPORT"],
                            ca_ops_road_export: ["Export", "ROAD EXPORT"], ca_ops_general: ["General", "GEN"] };

async function canadaJobs(db) {
  const perCollection = await Promise.all(CA_JOB_COLLECTIONS.map((name) => db.collection(name)
    .find({}, { projection: { _id: 0, financialLockDate: 1, financialLock: 1, operationLockDate: 1, operationLock: 1, syncedAt: 1,
                              shipmentId: 1, direction: 1, lob: 1, jobBranch: 1, branch: 1, location: 1, operator: 1, jobOwner: 1,
                              periodDate: 1, jobDate: 1, isOpen: 1 } })
    .toArray().then((docs) => docs.map((d) => ({ ...d, _col: name })))));
  const out = { fields: JOB_FIELDS, rows: [], syncedAt: "" };
  for (const d of perCollection.flat()) {
    if (d.syncedAt && String(d.syncedAt) > out.syncedAt) out.syncedAt = String(d.syncedAt);
    const [colDir, colLob] = CA_COLLECTION_LOB[d._col];
    out.rows.push([
      String(d.shipmentId ?? ""), d.direction || colDir, d.lob || colLob,
      d.jobBranch || d.branch || d.location || "(No Branch)", d.operator || d.jobOwner || "(Unknown)",
      d.periodDate || d.jobDate || "",
      d.isOpen !== undefined ? !!d.isOpen : !filled(d.operationLockDate),
      finPendingOf(d), opsPendingOf(d),
    ]);
  }
  return out;
}

async function canadaData(db) {
  const [jobs, evaJobs, evaLast] = await Promise.all([
    canadaJobs(db), canadaEvaJobs(db),
    db.collection(CA_EVA).find({ syncedAt: { $exists: true } }, { projection: { _id: 0, syncedAt: 1 } })
      .sort({ syncedAt: -1 }).limit(1).toArray(),
  ]);
  const { syncedAt, ...jobRows } = jobs;
  return { jobs: jobRows, evaJobs,
           dataRefreshedAt: { jobs: syncedAt, estimatedVsActual: evaLast[0] ? String(evaLast[0].syncedAt) : "" } };
}

// ---------------------------------------------------------------- SAR USA (sar-usa-ops)

const US_JOBS = "usa_ops_jobs";
const US_ETDETA = "usa_ops_etdeta";
const US_LOB_RE = /^(SEA|AIR|ROAD) (EXPORT|IMPORT)$/;
const titleCase = (s) => String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// One row per job in usa_ops_jobs, as the USA dashboard reads them: branch = jobBranch › branch ›
// location, owner = operator › jobOwner, period = ETD/ETA New › Job Date, open = no Operation Lock Date.
async function usaJobs(db) {
  const docs = await db.collection(US_JOBS)
    .find({}, { projection: { _id: 0, shipmentId: 1, direction: 1, lob: 1, jobBranch: 1, branch: 1, location: 1, operator: 1,
                              jobOwner: 1, etdEtaNew: 1, jobDate: 1, operationLockDate: 1, operationLock: 1,
                              financialLockDate: 1, financialLock: 1 } }).toArray();
  return { fields: JOB_FIELDS, rows: docs.map((d) => {
    const lob = String(d.lob || "").trim().toUpperCase();
    const direction = d.direction || (/EXPORT/.test(lob) ? "Export" : /IMPORT/.test(lob) ? "Import" : titleCase(lob.split(" ").pop() || ""));
    return [
      String(d.shipmentId ?? ""), direction, lob,
      d.jobBranch || d.branch || d.location || "(No Branch)", d.operator || d.jobOwner || "(Unknown)",
      d.etdEtaNew || d.jobDate || "",
      !filled(d.operationLockDate), finPendingOf(d), opsPendingOf(d),
    ];
  }) };
}

// One row per shipment and LOB in usa_ops_etdeta (groupEtdEtaByShipment in the USA dashboard):
// only Sea / Air / Road Export and Import lines; branch = location, owner = jobOwner, period =
// the first line's ETD/ETA New; amounts summed over the shipment's lines.
async function usaEvaJobs(db) {
  const rows = await db.collection(US_ETDETA)
    .find({}, { projection: { _id: 0, shipmentId: 1, lobExportImport: 1, location: 1, jobOwner: 1, etdEtaNew: 1,
                              unbilledRevenue: 1, unpostedCost: 1 } }).toArray();
  const byJob = new Map();
  for (const e of rows) {
    const job = String(e.shipmentId ?? "").trim();
    const lob = String(e.lobExportImport || "").trim().toUpperCase();
    if (!job || !US_LOB_RE.test(lob)) continue;
    const key = job + "\u0001" + lob;
    let t = byJob.get(key);
    if (!t) {
      t = { job, lob, direction: titleCase(lob.split(" ")[1]), location: e.location || "", jobOwner: e.jobOwner || "",
            etdEtaNew: e.etdEtaNew || "", rev: 0, cost: 0 };
      byJob.set(key, t);
    }
    t.rev  += toNum(e.unbilledRevenue);
    t.cost += toNum(e.unpostedCost);
  }
  return { fields: EVA_JOB_FIELDS, rows: [...byJob.values()].map((t) => evaRow([
    t.job, t.direction, t.lob, t.location || "(No Branch)", t.jobOwner || "(Unknown)", t.etdEtaNew,
  ], t.rev, t.cost)) };
}

async function usaData(db) {
  const [jobs, evaJobs, stamps] = await Promise.all([
    usaJobs(db), usaEvaJobs(db),
    db.collection("_meta").find({ _id: { $in: ["lastPush_" + US_JOBS, "lastPush_" + US_ETDETA] } }).toArray(),
  ]);
  const at = (id) => { const s = stamps.find((d) => d._id === id); const t = s ? new Date(s.updatedAt) : null; return t && !isNaN(t) ? t.toISOString() : ""; };
  return { jobs, evaJobs, dataRefreshedAt: { jobs: at("lastPush_" + US_JOBS), estimatedVsActual: at("lastPush_" + US_ETDETA) } };
}

// ---------------------------------------------------------------- SAR Indonesia (sar-id-ops) and Thailand (sar-th-ops)

// Both sea ops dashboards share one schema (CargoWise exports); only the cross-trade collection differs.
const SEA_JOB_COLLECTIONS = {
  indonesia: ["th_ops_export", "th_ops_import", "id_ops_crosstrade"],
  thailand:  ["th_ops_export", "th_ops_import", "th_ops_crosstrade"],
};
const ID_WIP = "th_ops_wip";
const DAY = 864e5;
const idDirection = (d) => {   // getRecordDirection in the Indonesia dashboard: 2nd letter of the LOB code
  const c = String(d.lob || "").toUpperCase().charAt(1);
  return c === "E" ? "Export" : c === "I" ? "Import" : (d.direction || "");
};
const asDate = (v) => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d : null; };
const newestId = (docs) => docs.reduce((m, d) => {
  const t = d._id && typeof d._id.getTimestamp === "function" ? d._id.getTimestamp().getTime() : 0;
  return t > m ? t : m;
}, 0);

async function seaOpsData(db, entity) {
  const [jobDocs, wip] = await Promise.all([
    Promise.all(SEA_JOB_COLLECTIONS[entity].map((name) => db.collection(name)
      .find({}, { projection: { _id: 1, shipmentId: 1, lob: 1, direction: 1, jobBranch: 1, branch: 1, operator: 1, jobOwner: 1,
                                originEtd: 1, destinationEta: 1, jobOpenedDate: 1, jobStatus: 1, operationLock: 1,
                                operationsLockedOn: 1, financialLock: 1, financialsLockedOn: 1 } }).toArray())).then((a) => a.flat()),
    db.collection(ID_WIP).find({}, { projection: { _id: 1, shipmentId: 1, wip: 1, accrual: 1 } }).toArray(),
  ]);
  // WIP > 0 lines and accrual ≠ 0 lines per shipment, as renderUnbilledRev / renderUnpostedCost build them
  const byJob = new Map();
  for (const w of wip) {
    const job = String(w.shipmentId ?? "").trim();
    if (!job) continue;
    const t = byJob.get(job) || { wip: 0, wipLines: 0, accrual: 0, accLines: 0 };
    const wv = toNum(w.wip), av = toNum(w.accrual);
    if (wv > 0) { t.wip += wv; t.wipLines++; }
    if (av !== 0) { t.accrual += av; t.accLines++; }
    byJob.set(job, t);
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cut3 = new Date(today - 3 * DAY), cut7 = new Date(today - 7 * DAY);
  const jobs = { fields: JOB_FIELDS, rows: [] }, evaJobs = { fields: EVA_JOB_FIELDS, rows: [] };
  for (const d of jobDocs) {
    const job = String(d.shipmentId ?? "").trim();
    const direction = idDirection(d);
    const imp = direction === "Import";
    const period = (imp ? d.destinationEta : d.originEtd) || d.jobOpenedDate || "";
    const threshold = asDate(imp ? d.destinationEta : d.originEtd);   // thresholdDate()
    const closed = ["CMP", "CLS"].includes(String(d.jobStatus || "").toUpperCase());
    const base = [job, direction, String(d.lob || "").toUpperCase(), d.jobBranch || d.branch || "(No Branch)",
                  d.operator || d.jobOwner || "(Unknown)", period];
    jobs.rows.push([...base, !closed && !!threshold && threshold < cut7,
                    !(filled(d.financialsLockedOn) || filled(d.financialLock)),
                    !(filled(d.operationsLockedOn) || filled(d.operationLock))]);
    const t = byJob.get(job) || { wip: 0, wipLines: 0, accrual: 0, accLines: 0 };
    evaJobs.rows.push([...base, round2(t.wip), round2(t.accrual),
                       t.wipLines > 0 && !!threshold && threshold < cut3, t.accLines > 0 && !!threshold && threshold < cut7]);
  }
  const iso = (ms) => ms ? new Date(ms).toISOString() : "";
  return { jobs, evaJobs, dataRefreshedAt: { jobs: iso(newestId(jobDocs)), estimatedVsActual: iso(newestId(wip)) } };
}

// ---------------------------------------------------------------- pop-up details

// Detail rows for the pop-ups, fetched only when one is opened (same columns as each ops dashboard's
// drill-downs): jobDetails = the job records, chargeLines = charge lines with a positive unbilled
// revenue / unposted cost.
const JOB_DETAIL_FIELDS = ["shipmentId", "etdEtaNew", "periodDate", "location", "jobBranch", "branch", "jobOwner", "operator",
  "salesPerson", "customer", "cargoType", "etdLoadingPort", "etaDischarge", "jobDate", "loadingPort", "originPortCountry",
  "dischargePort", "destinationCountry", "houseNo", "consolNo", "carrierNumber", "carrier", "masterNo", "consignee", "shipper",
  "toiIncoTerms", "lob", "direction"];
const CA_CHARGE_FIELDS = ["jobNo", "lob", "lob2", "etdEtaNew", "etdEta", "charge", "unbilledRevenue", "unpostedCost", "unbilledCost",
  "jobDate", "receivableFrom", "payableTo", "organization", "jobOwner", "salesPerson", "location", "operationLockDate",
  "estimatedRevenue", "bookedRevenue", "actualRevenue", "estimatedCost", "bookedCost", "actualCost", "estimatedProfit",
  "actualProfit", "financialLockDate"];
const US_CHARGE_FIELDS = ["shipmentId", "lob", "lobExportImport", "etdEtaNew", "charge", "unbilledRevenue", "unpostedCost",
  "jobDate", "organization", "jobOwner", "location", "operationLockDate", "estimatedRevenueUsd", "bookedRevenueUsd",
  "actualRevenueUsd", "estimatedCostUsd", "bookedCostUsd", "actualCostUsd", "estimatedProfitUsd", "actualProfitUsd",
  "financialLockDate", "receivableFrom", "payableTo"];
const ID_JOB_DETAIL_FIELDS = ["shipmentId", "jobStatus", "jobBranch", "jobDept", "operator", "salesRep", "localClientName", "mode",
  "direction", "lob", "originEtd", "destinationEta", "jobOpenedDate", "origin", "originCtry", "destination", "destCtry", "houseRef",
  "consolId", "vessel", "carrierName", "mblNumber", "containerNo", "consigneeName", "consignorName", "incoterm"];
const ID_WIP_FIELDS = ["shipmentId", "chargeCode", "wip", "revenue", "accrual", "invoiceNumber", "recognized", "chargeType", "cost",
  "lob", "etdEta", "etd", "eta", "localRef", "trans", "cont", "jobBranch", "jobDept", "jobStatus", "localClient", "operator"];
const MAX_DETAIL_JOBS = 5000;

function jobIds(body) {
  const ids = [...new Set((Array.isArray(body.jobNos) ? body.jobNos : []).map((j) => String(j ?? "").trim()).filter(Boolean))];
  if (ids.length > MAX_DETAIL_JOBS) throw new HttpError(400, `Too many jobs (${ids.length}); narrow the months or LOB.`);
  return ids;
}
// Job numbers may be stored as text or as numbers: match both
const anyOf = (ids) => ({ $in: [...ids, ...ids.filter((j) => /^\d+$/.test(j)).map(Number)] });

async function jobDetails(db, entity, body) {
  const ids = jobIds(body);
  if (!ids.length) return { rows: [] };
  const names = entity === "usa" ? [US_JOBS] : SEA_JOB_COLLECTIONS[entity] || CA_JOB_COLLECTIONS;
  const fields = SEA_JOB_COLLECTIONS[entity] ? ID_JOB_DETAIL_FIELDS : JOB_DETAIL_FIELDS;
  const rows = (await Promise.all(names.map((name) => db.collection(name)
    .find({ shipmentId: anyOf(ids) }, { projection: projectionOf(fields) }).toArray()))).flat();
  return { rows };
}

async function chargeLines(db, entity, body) {
  const ids = jobIds(body);
  if (!ids.length) return { rows: [] };
  const cost = body.kind === "cost";
  if (SEA_JOB_COLLECTIONS[entity]) {
    const filter = { shipmentId: anyOf(ids), ...(cost ? { accrual: { $nin: [0, null, ""] } } : { wip: { $gt: 0 } }) };
    return { rows: await db.collection(ID_WIP).find(filter, { projection: projectionOf(ID_WIP_FIELDS) }).toArray() };
  }
  if (entity === "usa") {
    const filter = { shipmentId: anyOf(ids), lobExportImport: { $regex: US_LOB_RE.source, $options: "i" },
                     [cost ? "unpostedCost" : "unbilledRevenue"]: { $gt: 0 } };
    return { rows: await db.collection(US_ETDETA).find(filter, { projection: projectionOf(US_CHARGE_FIELDS) }).toArray() };
  }
  const filter = cost
    ? { jobNo: anyOf(ids), $or: [{ unpostedCost: { $gt: 0 } }, { unbilledCost: { $gt: 0 } }] }
    : { jobNo: anyOf(ids), unbilledRevenue: { $gt: 0 } };
  const rows = await db.collection(CA_EVA).find(filter, { projection: projectionOf(CA_CHARGE_FIELDS) }).toArray();
  for (const c of rows) {
    // Canada sheet naming: unbilledCost is the unposted cost
    if (!filled(c.unpostedCost)) c.unpostedCost = c.unbilledCost;
  }
  return { rows };
}

// ---------------------------------------------------------------- handler

const cache = new Map();   // entity -> { payload, at }

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const body = req.body || {};
  const entity = ENTITIES[body.dataset] ? body.dataset : (body.entity || "canada");
  try {
    await authenticate(req);
    entityOf(entity);
    if (body.dataset === "jobDetails") return res.status(200).json(await jobDetails(await getDb(entity), entity, body));
    if (body.dataset === "chargeLines") return res.status(200).json(await chargeLines(await getDb(entity), entity, body));
    if (!ENTITIES[body.dataset]) throw new HttpError(400, "Unknown dataset");
    const hit = cache.get(entity);
    if (body.refresh || !hit || Date.now() - hit.at > TTL_MS) {
      const db = await getDb(entity);
      const data = entity === "usa" ? await usaData(db) : SEA_JOB_COLLECTIONS[entity] ? await seaOpsData(db, entity) : await canadaData(db);
      cache.set(entity, { payload: { ...data, builtAt: new Date().toISOString() }, at: Date.now() });
    }
    return res.status(200).json(cache.get(entity).payload);
  } catch (err) {
    const e = ENTITIES[entity];
    const envName = e ? (e.envs.find((n) => process.env[n]) || e.envs[0]) : "the connection string";
    return sendError(res, err instanceof HttpError ? err : mongoError(err, envName, e ? e.db : ""));
  }
}

// Turns a MongoDB driver error into a message that says what to fix (no secrets in it).
function mongoError(err, envName, dbName) {
  console.error("mongo-batch:", err);
  // Mask any user:password@ the driver might echo back
  const m = String(err && err.message || "").replace(/\/\/[^/@\s]*@/g, "//***@");
  const name = String(err && err.name || "");
  if (/authentication failed|bad auth/i.test(m)) return new HttpError(500, `Database sign-in failed: check the user name and password in ${envName}.`);
  if (/not authorized on|unauthorized/i.test(m)) return new HttpError(500, `The database user in ${envName} can't read ${dbName}: give it the read role on ${dbName}.`);
  if (/unescaped characters|must be escaped|percent-encoded/i.test(m)) return new HttpError(500, `The password in ${envName} has special characters (@ : / ? # %) that must be URL-encoded, e.g. @ → %40.`);
  if (/Server selection timed out|ENOTFOUND|ECONNREFUSED|querySrv|whitelist/i.test(m)) return new HttpError(500, `Can't reach the database: check the cluster address in ${envName} and that Atlas Network Access allows Vercel (0.0.0.0/0).`);
  if (name === "MongoParseError" || name === "MongoAPIError") return new HttpError(500, `${envName} can't be read: ` + m.slice(0, 200));
  return new HttpError(500, "Database error: " + m.slice(0, 200));
}
