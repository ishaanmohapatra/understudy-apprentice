// Returns a short-lived signed URL so the ElevenLabs API key never reaches the browser.
export async function GET() {
  const key = process.env.ELEVENLABS_API_KEY;
  const agent = process.env.ELEVENLABS_AGENT_ID;
  if (!key || !agent) {
    return Response.json({ error: "Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in .env.local" }, { status: 500 });
  }
  const r = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agent)}`,
    { headers: { "xi-api-key": key }, cache: "no-store" }
  );
  if (!r.ok) return Response.json({ error: `ElevenLabs ${r.status}: ${await r.text()}` }, { status: 502 });
  const { signed_url } = await r.json();
  return Response.json({ signedUrl: signed_url });
}
