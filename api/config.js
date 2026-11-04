// GET /api/config → { googleClientId }   (public; the client ID is not a secret)

import { GOOGLE_CLIENT_ID } from "./_auth.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  return res.status(200).json({ googleClientId: GOOGLE_CLIENT_ID });
}
