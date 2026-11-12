// SAR Internal Audit Dashboard — sign-in API (Vercel serverless function).
//
//   GET  /api/mongo?config=1        -> { googleClientId }                 (public; the client ID is not a secret)
//   POST /api/mongo  { dataset: "me" } -> { email, name, picture, role }  (signed in)
//   POST /api/mongo  { dataset: "users" }                          -> { users }   (admin)
//   POST /api/mongo  { dataset: "saveUser", email, name, role, active } -> { ok }  (admin; adds or updates)
//   POST /api/mongo  { dataset: "deleteUser", email }               -> { ok }      (admin)
//   POST /api/mongo  { dataset: "checklist", company, month }       -> { rows }    (signed in; month "2026-11")
//   POST /api/mongo  { dataset: "saveChecklist", company, month, item, week, status, completedOn, remarks } -> { row }
//                                                                                   (Admin or Strategy)
//
// Audit checklist: collection "checklist" of sar-internal-audit, one document per company, month and
// audit point { company, month, item, week, status, completedOn, remarks, updatedBy, updatedAt }. week is 0
// for monthly points; weekly points (26 AS reconciliation) keep one document per week of the month, 1–6.
//
// Who can sign in: the "users" collection of database sar-internal-audit (env AUDIT_URI), one document
// per person { email, name, role: "Admin" | "Strategy" | "Viewer", active }; each sign-in sets lastLoginAt and adds 1 to loginCount. Only active users on the list get in.
// ADMIN_EMAILS always get in as Admin, so the list can't lock everyone out. Without AUDIT_URI the
// old rule applies: anyone on an allowed domain is a Viewer.
// The browser signs in with Google (OAuth client in Google Cloud project sar-group-internal-audit)
// and sends "Authorization: Bearer <Google ID token>" on every call. api/mongo-batch.js uses the
// same check (authenticate) for the data it returns.
// Environment: GOOGLE_CLIENT_ID (optional, overrides the default below),
//              ALLOWED_DOMAINS (default sarlogisolutions.com, sartransport.com), ADMIN_EMAILS (comma-separated),
//              AUDIT_URI (cluster holding sar-internal-audit; AUDIT_MONGO_DB renames it).

import { MongoClient } from "mongodb";

// OAuth Web client "sar-group-internal-audit". Not a secret; GOOGLE_CLIENT_ID overrides it.
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
  || "992681345746-2amabulkf8lff4gjlvvc1gjqaj5r8kgf.apps.googleusercontent.com";

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const list = (v) => (v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const allowedDomains = () => list(process.env.ALLOWED_DOMAINS || "sarlogisolutions.com,sartransport.com");

// ============================================================ MongoDB (shared with api/mongo-batch.js)
const g = globalThis;
g._auditMongo = g._auditMongo || new Map();   // connection string -> connecting client

/** The database dbName on the cluster in the first of envNames that is set. */
export async function connectDb(envNames, dbName) {
  const envName = envNames.find((n) => process.env[n]) || envNames[0];
  // Forgive common paste slips: spaces or new lines, surrounding quotes, a leading "NAME=".
  const uri = String(process.env[envName] || "").trim()
    .replace(/^[A-Z_]+\s*=\s*/, "").replace(/^["']|["']$/g, "").trim();
  if (!uri) throw new HttpError(500, `${envNames[0]} is not set`);
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
    return (await g._auditMongo.get(uri)).db(dbName);
  } catch (err) {
    throw mongoError(err, envName, dbName);
  }
}

// Turns a MongoDB driver error into a message that says what to fix (no secrets in it).
export function mongoError(err, envName, dbName) {
  console.error("mongo:", err);
  // Mask any user:password@ the driver might echo back
  const m = String(err && err.message || "").replace(/\/\/[^/@\s]*@/g, "//***@");
  const name = String(err && err.name || "");
  if (/authentication failed|bad auth/i.test(m)) return new HttpError(500, `Database sign-in failed: check the user name and password in ${envName}.`);
  if (/not authorized on|unauthorized/i.test(m)) return new HttpError(500, `The database user in ${envName} can't use ${dbName}: give it the right role on ${dbName}.`);
  if (/unescaped characters|must be escaped|percent-encoded/i.test(m)) return new HttpError(500, `The password in ${envName} has special characters (@ : / ? # %) that must be URL-encoded, e.g. @ → %40.`);
  if (/Server selection timed out|ENOTFOUND|ECONNREFUSED|querySrv|whitelist/i.test(m)) return new HttpError(500, `Can't reach the database: check the cluster address in ${envName} and that Atlas Network Access allows Vercel (0.0.0.0/0).`);
  if (name === "MongoParseError" || name === "MongoAPIError") return new HttpError(500, `${envName} can't be read: ` + m.slice(0, 200));
  return new HttpError(500, "Database error: " + m.slice(0, 200));
}

// ============================================================ user list
const AUDIT_DB = process.env.AUDIT_MONGO_DB || "sar-internal-audit";
const usersCol = async () => (await connectDb(["AUDIT_URI"], AUDIT_DB)).collection("users");
const isAdminEmail = (e) => list(process.env.ADMIN_EMAILS).includes(e);
const userCache = new Map();   // email -> { doc, at }; a minute, so data calls don't each read the list
const USER_TTL_MS = 60 * 1000;
// Matches the email whatever its case in the list (people may type capitals in Atlas)
const escapeRe = (s) => s.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
const emailQuery = (email) => ({ email: { $regex: "^" + escapeRe(email) + "$", $options: "i" } });

async function listedUser(email) {
  const hit = userCache.get(email);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.doc;
  const doc = await (await usersCol()).findOne(emailQuery(email));
  userCache.set(email, { doc, at: Date.now() });
  return doc;
}

// Roles as stored in the list. Strategy and Viewer see the same data for now; only Admins manage users.
const ROLES = ["Admin", "Strategy", "Viewer"];
const roleName = (v) => ROLES.find((r) => r.toLowerCase() === String(v || "").trim().toLowerCase()) || "Viewer";

/** "admin" | "strategy" | "viewer" | null (no access). */
export async function roleFor(email) {
  const e = email.toLowerCase();
  if (isAdminEmail(e)) return "admin";
  if (!process.env.AUDIT_URI) return allowedDomains().includes(e.split("@")[1]) ? "viewer" : null;
  const u = await listedUser(e);
  if (!u || u.active === false) return null;
  return roleName(u.role).toLowerCase();
}

const tokenCache = new Map(); // idToken -> { user, exp }

async function verifyGoogleToken(idToken) {
  const hit = tokenCache.get(idToken);
  if (hit && hit.exp > Date.now()) return hit.user;

  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!r.ok) throw new HttpError(401, "Sign-in expired. Please sign in again.");
  const t = await r.json();
  const expMs = Number(t.exp) * 1000;
  if (t.aud !== GOOGLE_CLIENT_ID || !["accounts.google.com", "https://accounts.google.com"].includes(t.iss)
      || String(t.email_verified) !== "true" || !(expMs > Date.now())) {
    throw new HttpError(401, "Sign-in expired. Please sign in again.");
  }
  const user = { email: t.email.toLowerCase(), name: t.name || t.email, picture: t.picture || "" };
  if (tokenCache.size > 500) tokenCache.clear();
  tokenCache.set(idToken, { user, exp: expMs });
  return user;
}

/** Returns { email, name, picture, role } or throws 401 / 403. */
export async function authenticate(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) throw new HttpError(401, "Not signed in");
  const user = await verifyGoogleToken(h.slice(7));
  const role = await roleFor(user.email);
  if (!role) throw new HttpError(403, `${user.email} is not on the user list of this dashboard. Ask an Admin to add you.`, "no_access");
  return { ...user, role };
}

export function sendError(res, err) {
  const known = err instanceof HttpError;
  if (!known || err.status >= 500) console.error(err);
  return res.status(known ? err.status : 500).json({ error: known ? err.message : "Server error", code: err.code });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function manageUsers(me, body) {
  const col = await usersCol();
  if (body.dataset === "users") {
    const users = await col.find({}, { projection: { _id: 0, email: 1, name: 1, role: 1, active: 1, addedBy: 1, addedAt: 1, updatedAt: 1, lastLoginAt: 1, loginCount: 1 } })
      .sort({ name: 1, email: 1 }).toArray();
    return { users, breakGlass: list(process.env.ADMIN_EMAILS) };
  }
  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "Enter a valid email address.");
  if (!allowedDomains().includes(email.split("@")[1])) throw new HttpError(400, `Only ${allowedDomains().join(", ")} accounts can be added.`);
  userCache.delete(email);
  if (body.dataset === "deleteUser") {
    if (email === me.email) throw new HttpError(400, "You can't remove yourself.");
    await col.deleteMany(emailQuery(email));
    return { ok: true };
  }
  const role = roleName(body.role);
  const active = body.active !== false;
  if (email === me.email && (role !== "Admin" || !active)) throw new HttpError(400, "You can't remove your own Admin access.");
  const now = new Date();
  await col.updateOne(
    emailQuery(email),
    { $set: { email, name: String(body.name || "").trim() || email, role, active, updatedAt: now, updatedBy: me.email },
      $setOnInsert: { addedAt: now, addedBy: me.email } },
    { upsert: true },
  );
  return { ok: true };
}

// ============================================================ audit checklist
const CHECK_STATUSES = ["Pending", "In Progress", "Completed", "Not Applicable"];
const COMPANIES = ["STSPL", "SAR USA", "SAR Canada", "SAR Thailand", "SAR Indonesia"];   // the company tab names
const checklistCol = async () => (await connectDb(["AUDIT_URI"], AUDIT_DB)).collection("checklist");

async function checklist(me, body) {
  const company = String(body.company || "");
  const month = String(body.month || "");
  if (!COMPANIES.includes(company)) throw new HttpError(400, "Unknown company.");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "Month must look like 2026-11.");
  const col = await checklistCol();
  const projection = { _id: 0, item: 1, week: 1, status: 1, completedOn: 1, remarks: 1, updatedBy: 1, updatedAt: 1 };
  if (body.dataset === "checklist") return { rows: await col.find({ company, month }, { projection }).toArray() };

  if (!["admin", "strategy"].includes(me.role)) throw new HttpError(403, "Only Admin and Strategy users can update the checklist.");
  const item = Number(body.item);
  if (!Number.isInteger(item) || item < 1 || item > 500) throw new HttpError(400, "Unknown audit point.");
  const week = Number(body.week) || 0;
  if (!Number.isInteger(week) || week < 0 || week > 6) throw new HttpError(400, "Unknown week.");
  const status = CHECK_STATUSES.includes(body.status) ? body.status : "Pending";
  const completedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.completedOn || "")) ? body.completedOn : "";
  const remarks = String(body.remarks || "").trim().slice(0, 1000);
  const row = { item, week, status, completedOn, remarks, updatedBy: me.email, updatedAt: new Date() };
  await col.updateOne({ company, month, item, week: week || { $in: [0, null] } }, { $set: { company, month, ...row } }, { upsert: true });
  return { row };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && req.query && req.query.config) return res.status(200).json({ googleClientId: GOOGLE_CLIENT_ID });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = req.body || {};
    const me = await authenticate(req);
    if (body.dataset === "me") {
      if (process.env.AUDIT_URI) {
        (await usersCol()).updateOne(emailQuery(me.email), { $set: { lastLoginAt: new Date() }, $inc: { loginCount: 1 } })
          .catch((err) => console.error("lastLoginAt:", err));
      }
      return res.status(200).json(me);
    }
    if (["users", "saveUser", "deleteUser"].includes(body.dataset)) {
      if (me.role !== "admin") throw new HttpError(403, "Only an Admin can manage users.");
      if (!process.env.AUDIT_URI) throw new HttpError(500, "AUDIT_URI is not set: the user list needs it.");
      return res.status(200).json(await manageUsers(me, body));
    }
    if (["checklist", "saveChecklist"].includes(body.dataset)) {
      if (!process.env.AUDIT_URI) throw new HttpError(500, "AUDIT_URI is not set: the checklist needs it.");
      return res.status(200).json(await checklist(me, body));
    }
    throw new HttpError(400, "Unknown request");
  } catch (err) {
    return sendError(res, err);
  }
}
