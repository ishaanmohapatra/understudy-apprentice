// Describes what changed on screen between two frames. Never guesses *why*.
// Uses Anthropic if ANTHROPIC_API_KEY is set, otherwise OpenAI if OPENAI_API_KEY is set.
const PROMPT = `You watch an accounts-payable clerk's screen (a sandbox invoice app).
Compare PREVIOUS and CURRENT screenshots. In ONE short line, state only the visible change
(e.g. "Cost center field changed from 4711 to 0400 on invoice INV-4471").
Never guess the reason. If nothing meaningful changed, reply exactly: NO_CHANGE`;

export async function POST(req: Request) {
  const { prev, curr } = (await req.json()) as { prev?: string; curr: string };
  const strip = (d: string) => d.replace(/^data:image\/\w+;base64,/, "");
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const img = (d: string) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: strip(d) } });
      const content: unknown[] = [];
      if (prev) content.push({ type: "text", text: "PREVIOUS:" }, img(prev));
      content.push({ type: "text", text: "CURRENT:" }, img(curr), { type: "text", text: PROMPT });
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.VISION_MODEL || "claude-haiku-4-5-20251001",
          max_tokens: 80,
          messages: [{ role: "user", content }],
        }),
      });
      const j = await r.json();
      if (!r.ok) return Response.json({ error: JSON.stringify(j) }, { status: 502 });
      return Response.json({ text: j.content?.[0]?.text?.trim() ?? "NO_CHANGE" });
    }
    if (process.env.OPENAI_API_KEY) {
      const content: unknown[] = [];
      if (prev) content.push({ type: "text", text: "PREVIOUS:" }, { type: "image_url", image_url: { url: prev } });
      content.push({ type: "text", text: "CURRENT:" }, { type: "image_url", image_url: { url: curr } }, { type: "text", text: PROMPT });
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: process.env.VISION_MODEL || "gpt-4o-mini", max_tokens: 80, messages: [{ role: "user", content }] }),
      });
      const j = await r.json();
      if (!r.ok) return Response.json({ error: JSON.stringify(j) }, { status: 502 });
      return Response.json({ text: j.choices?.[0]?.message?.content?.trim() ?? "NO_CHANGE" });
    }
    return Response.json({ error: "No vision key (ANTHROPIC_API_KEY or OPENAI_API_KEY)" }, { status: 500 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
