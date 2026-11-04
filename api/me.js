// POST /api/me  (Authorization: Bearer <Google ID token>) → { email, name, picture, role }

import { authenticate, sendError } from "./_auth.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    return res.status(200).json(await authenticate(req));
  } catch (err) {
    return sendError(res, err);
  }
}
