// SAR Internal Audit Dashboard — GET /api/last-updated → { lastUpdated: ISO string | null }
//
// When fresh data last arrived in any of the company databases this dashboard reads (see lastRefreshedAt in
// api/mongo-batch.js). Read by the SAR Systems Hub for the "Updated …" line on this dashboard's card.
// Returns a single timestamp and no data, so it needs no sign-in.
// The Hub gives up after 5 seconds and a cold start opens six database connections, so this answers within
// about 3 seconds with the companies that have replied by then (kept 10 seconds), and otherwise keeps the
// full answer for a minute.

import { lastRefreshedAt } from "./mongo-batch.js";

const WAIT_MS = 3000;
let cached = null;   // { value, until }

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    if (!cached || Date.now() > cached.until) {
      const r = await lastRefreshedAt(WAIT_MS);
      cached = { value: r.value, until: Date.now() + (r.complete ? 60_000 : 10_000) };
    }
    return res.status(200).json({ lastUpdated: cached.value });
  } catch (err) {
    console.error("last-updated:", err && err.message);
    return res.status(500).json({ lastUpdated: null });
  }
}
