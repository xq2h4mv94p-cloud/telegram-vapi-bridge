import express from "express";

const app = express();
app.use(express.json());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;

// chatId -> sessionId (pro start ok; na produkci raději DB/Redis)
const sessions = new Map();

app.get("/", (req, res) => res.send("ok"));

app.post("/telegram", async (req, res) => {
  try {
    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = msg?.text;

    // ignoruj jiné typy update (např. stickers, joins, callbacks)
    if (!chatId || !text) return res.sendStatus(200);

    if (!TELEGRAM_BOT_TOKEN || !VAPI_PRIVATE_KEY || !VAPI_ASSISTANT_ID) {
      // když chybí env vars, radši jen potichu skonči (Telegram nebude retryovat donekonečna)
      return res.sendStatus(200);
    }

    // 1) session (paměť konverzace)
    let sessionId = sessions.get(chatId);
    if (!sessionId) {
      const s = await fetch("https://api.vapi.ai/session", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VAPI_PRIVATE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          assistantId: VAPI_ASSISTANT_ID,
          name: `tg:${chatId}`,
        }),
      }).then((r) => r.json());

      sessionId = s?.id;
      if (sessionId) sessions.set(chatId, sessionId);
    }

    // 2) pošli do Vapi Chat
    const chat = await fetch("https://api.vapi.ai/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VAPI_PRIVATE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assistantId: VAPI_ASSISTANT_ID, // důležité
        sessionId,                      // drží kontext
        input: text,
      }),
    }).then((r) => r.json());

    // 3) vytáhni odpověď robustně (Vapi může vracet různé tvary)
    const reply =
      (Array.isArray(chat?.output) &&
        chat.output.map((o) => o?.content).filter(Boolean).join("\n")) ||
      chat?.output?.[0]?.content ||
      chat?.text ||
      chat?.message ||
      "Vapi nevrátilo textovou odpověď.";

    // 4) odpověz do Telegramu
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: reply }),
    });

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port));
