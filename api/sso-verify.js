// SAR Internal Audit Dashboard — sign-in from the SAR Systems Hub (Vercel serverless function).
//
//   POST /api/sso-verify   form fields: sso_token (Hub launch token), widget_token, hub_origin (both unused)
//
// The Hub signs a 60-second HS256 launch token with SSO_SHARED_SECRET (issuer "sar-systems-hub") and posts it
// here through its /dashboards/<slug>/ proxy. If the signature, issuer and expiry check out and the email is an
// active user on this dashboard's user list (the same rule as Google sign-in, see api/mongo.js), the browser gets
// a session token of this dashboard (12 hours) in sessionStorage and goes to the page, which signs in with it.
// Nothing here is put in a URL.
// Environment: SSO_SHARED_SECRET (the same value as the Hub's), plus what api/mongo.js needs (AUDIT_URI, …).

import crypto from "node:crypto";
import { roleFor, nameFor, mintSession } from "./mongo.js";

const HUB_ISSUER = "sar-systems-hub";

const unb64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

function verifyHubToken(token, secret) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [head, body, sig] = parts;
  const header = JSON.parse(unb64url(head).toString("utf8"));
  if (header.alg !== "HS256") throw new Error("unexpected alg " + header.alg);
  const want = crypto.createHmac("sha256", secret).update(head + "." + body).digest();
  const got = unb64url(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new Error("bad signature");
  const p = JSON.parse(unb64url(body).toString("utf8"));
  if (p.iss !== HUB_ISSUER) throw new Error("unexpected issuer " + p.iss);
  if (typeof p.exp !== "number" || Math.floor(Date.now() / 1000) >= p.exp) throw new Error("token expired");
  return p;
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function messagePage(title, text) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4F6FA;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1C2136;padding:16px}
.card{max-width:420px;background:#fff;border-radius:16px;padding:32px 36px;box-shadow:0 8px 30px rgba(28,33,54,.08)}h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#4B536E}</style>
</head><body><div class="card"><h1>${esc(title)}</h1><p>${esc(text)}</p></div></body></html>`;
}

function handoffPage(session) {
  const tokenJson = JSON.stringify(session).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Signing in…</title></head>
<body style="font:14px system-ui,sans-serif;color:#4B536E;padding:24px">Signing you in…
<script>
  try { sessionStorage.setItem("auditSession", ${tokenJson}); } catch (e) {}
  location.replace("/");
</script></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.method !== "POST") return res.status(405).send(messagePage("Open it from the Hub", "Open the Internal Audit Dashboard from the SAR Systems Hub."));

  const expired = () => res.status(401).send(messagePage("Sign-in link expired", "Go back to the SAR Systems Hub and open the dashboard again."));
  const secret = process.env.SSO_SHARED_SECRET;
  if (!secret) { console.error("sso-verify: SSO_SHARED_SECRET is not set"); return expired(); }
  const token = req.body && req.body.sso_token;
  if (!token) return expired();

  let payload;
  try { payload = verifyHubToken(token, secret); }
  catch (err) { console.error("sso-verify: token check failed:", err.message); return expired(); }

  const email = String(payload.email || "").trim().toLowerCase();
  if (!email) return expired();

  try {
    const role = await roleFor(email);
    if (!role) {
      return res.status(403).send(messagePage("No access to this dashboard",
        `${email} is not an active user of the Internal Audit Dashboard. Ask an Admin to add you.`));
    }
    return res.status(200).send(handoffPage(mintSession(email, await nameFor(email))));
  } catch (err) {
    console.error("sso-verify:", err);
    return res.status(500).send(messagePage("Couldn't sign you in", "Something went wrong. Go back to the Hub and try again."));
  }
}
