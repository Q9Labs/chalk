import type { NextApiRequest, NextApiResponse } from "next";

const CHALK_API_KEY = process.env.CHALK_API_KEY;
const CHALK_API_URL = process.env.CHALK_API_URL || "https://chalk-api.q9labs.ai";

// Simple in-memory cache for tokens
let tokenCache: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} | null = null;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!CHALK_API_KEY) {
    console.error("CHALK_API_KEY not configured");
    return res.status(500).json({ error: "Server not configured" });
  }

  // Check cache (with 1 minute buffer before expiry)
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60000) {
    return res.status(200).json({
      accessToken: tokenCache.accessToken,
      refreshToken: tokenCache.refreshToken,
    });
  }

  try {
    const response = await fetch(`${CHALK_API_URL}/api/v1/auth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ api_key: CHALK_API_KEY }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Chalk API error:", response.status, error);
      return res.status(response.status).json({ error: "Authentication failed" });
    }

    const data = await response.json();
    const accessToken = data.accessToken || data.access_token;
    const refreshToken = data.refreshToken || data.refresh_token;

    // Cache for 14 minutes (tokens are 15 min)
    tokenCache = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 14 * 60 * 1000,
    };

    return res.status(200).json({ accessToken, refreshToken });
  } catch (error) {
    console.error("Token fetch error:", error);
    return res.status(500).json({ error: "Failed to get token" });
  }
}
