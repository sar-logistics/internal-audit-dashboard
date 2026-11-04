// SAR Internal Audit Dashboard — sign-in API (Vercel serverless function).
//
//   GET  /api/mongo?config=1        -> { googleClientId }                 (public; the client ID is not a secret)
//   POST /api/mongo  { dataset: "me" } -> { email, name, picture, role }  (signed in)
//
// The browser signs in with Google (OAuth client in Google Cloud project sar-group-internal-audit)
// and sends "Authorization: Bearer <Google ID token>" on every call. api/mongo-batch.js uses the
// same check (authenticate) for the data it returns.
// Environment: GOOGLE_CLIENT_ID (optional, overrides the default below),
//              ALLOWED_DOMAINS (default sarlogisolutions.com), ADMIN_EMAILS (comma-separated).

// OAuth Web client "sar-group-internal-audit". Not a secret; GOOGLE_CLIENT_ID overrides it.
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
  || "992681345746-2amabulkf8lff4gjlvvc1gjqaj5r8kgf.apps.googleusercontent.com";

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const list = (v) => (v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const allowedDomains = () => list(process.env.ALLOWED_DOMAINS || "sarlogisolutions.com");

/** admin: ADMIN_EMAILS; viewer: anyone on an allowed domain; otherwise no access. */
export function roleFor(email) {
  const e = email.toLowerCase();
  if (list(process.env.ADMIN_EMAILS).includes(e)) return "admin";
  if (allowedDomains().includes(e.split("@")[1])) return "viewer";
  return null;
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
  const role = roleFor(user.email);
  if (!role) throw new HttpError(403, `${user.email} does not have access to this dashboard`, "no_access");
  return { ...user, role };
}

export function sendError(res, err) {
  const known = err instanceof HttpError;
  if (!known || err.status >= 500) console.error(err);
  return res.status(known ? err.status : 500).json({ error: known ? err.message : "Server error", code: err.code });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && req.query && req.query.config) return res.status(200).json({ googleClientId: GOOGLE_CLIENT_ID });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { dataset } = req.body || {};
    if (dataset === "me") return res.status(200).json(await authenticate(req));
    throw new HttpError(400, "Unknown request");
  } catch (err) {
    return sendError(res, err);
  }
}
