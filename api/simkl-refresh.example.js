// Example serverless endpoint: POST /api/simkl/refresh
//
// Required environment variables:
// simkl_CLIENT_ID
// simkl_CLIENT_SECRET
// simkl_REDIRECT_URI

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const clientId = validatedsimklClientId(response);
  if (!clientId) return;

  const refreshToken = request.body && request.body.refresh_token;
  if (!refreshToken) {
    response.status(400).json({ error: "Missing refresh token" });
    return;
  }

  const simklResponse = await fetch("https://api.simkl.com/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Nuvio-simkl-Bridge/1.0",
    },
    body: JSON.stringify({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: String(process.env.simkl_CLIENT_SECRET || "").trim(),
      redirect_uri: String(process.env.simkl_REDIRECT_URI || "").trim(),
      grant_type: "refresh_token",
    }),
  });

  const text = await simklResponse.text();
  response.status(simklResponse.status);
  response.setHeader("Content-Type", "application/json");
  response.send(text || "{}");
}

function validatedsimklClientId(response) {
  const clientId = String(process.env.simkl_CLIENT_ID || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(clientId)) {
    response.status(500).json({
      error: "simkl sign-in is not configured on this server yet. The site owner needs to configure the bridge OAuth app server-side; users should only have to press Connect simkl.",
    });
    return "";
  }
  return clientId;
}
