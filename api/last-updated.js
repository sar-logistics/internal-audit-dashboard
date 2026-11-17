// SAR Internal Audit Dashboard — GET /api/last-updated → { lastUpdated: ISO string | null }
//
// When fresh data last arrived in any of the company databases this dashboard reads (see lastRefreshedAt in
// api/mongo-batch.js). Read by the SAR Systems Hub for the "Updated …" line on this dashboard's card.
// Returns a single timestamp and no data, so it needs no sign-in. Kept for a minute per server instance.

import { lastRefreshedAt } from "./mongo-batch.js";

const TTL_MS = 60 * 1000;
let cached = null;   // { value, at }

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    if (!cached || Date.now() - cached.at > TTL_MS) cached = { value: await lastRefreshedAt(), at: Date.now() };
    return res.status(200).json({ lastUpdated: cached.value });
  } catch (err) {
    console.error("last-updated:", err && err.message);
    return res.status(500).json({ lastUpdated: null });
  }
}
