// Example serverless endpoint: POST /api/simkl/login-url
//
// Required environment variables:
// simkl_CLIENT_ID
// simkl_REDIRECT_URI
//
// The frontend opens the returned URL in a popup. simkl reads the user's
// simkl.tv cookies there and asks them to approve access.

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const clientId = validatedsimklClientId(response);
  if (!clientId) return;

  const redirectUri = String(process.env.simkl_REDIRECT_URI || "").trim();
  if (!redirectUri) {
    response.status(500).json({ error: "Missing simkl_REDIRECT_URI." });
    return;
  }

  const state = crypto.randomUUID();
  const url = new URL("https://simkl.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  response.status(200).json({ url: url.toString(), state, client_id: clientId });
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
