// Returns a short-lived signed URL so the ElevenLabs API key never reaches
// the browser. Two agents per the brief: the Interviewer (Teach/debrief) and
// the Tutor (Train). ?agent=tutor selects the tutor; default is interviewer.
export async function GET(req: Request) {
  const key = process.env.ELEVENLABS_API_KEY;
  const which = new URL(req.url).searchParams.get("agent") === "tutor" ? "tutor" : "interviewer";
  const agent =
    which === "tutor"
      ? process.env.ELEVENLABS_TUTOR_AGENT_ID ?? process.env.ELEVENLABS_AGENT_ID
      : process.env.ELEVENLABS_AGENT_ID;
  if (!key || !agent) {
    return Response.json(
      { error: `Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID${which === "tutor" ? " (and ideally ELEVENLABS_TUTOR_AGENT_ID)" : ""} in .env.local` },
      { status: 501 },
    );
  }
  const r = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agent)}`,
    { headers: { "xi-api-key": key }, cache: "no-store" },
  );
  if (!r.ok) return Response.json({ error: `ElevenLabs ${r.status}: ${await r.text()}` }, { status: 502 });
  const { signed_url } = await r.json();
  return Response.json({ signedUrl: signed_url, agent: which });
}
