import express from "express";

const app = express();
app.use(express.json());

// jednoduchý access log (uvidíš v Render Logs, že webhook chodí)
app.use((req, res, next) => {
  console.log("INCOMING", req.method, req.path);
  next();
});

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;

// chatId -> sessionId
const sessions = new Map();

app.get("/", (req, res) => res.send("ok"));

app.post("/telegram", async (req, res) => {
  console.log("BODY", JSON.stringify(req.body)); // klíčové pro debug

  try {
    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = msg?.text;

    if (!chatId || !text) {
      console.log("IGNORED update (no chatId/text)");
      return res.sendStatus(200);
    }

    if (!TELEGRAM_BOT_TOKEN || !VAPI_PRIVATE_KEY || !VAPI_ASSISTANT_ID) {
      console.log("MISSING ENV VARS", {
        hasTelegramToken: !!TELEGRAM_BOT_TOKEN,
        hasVapiKey: !!VAPI_PRIVATE_KEY,
        hasAssistantId: !!VAPI_ASSISTANT_ID
      });
      return res.sendStatus(200);
    }

    // 1) session
    let sessionId = sessions.get(chatId);
    if (!sessionId) {
      const sResp = await fetch("https://api.vapi.ai/session", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VAPI_PRIVATE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          assistantId: VAPI_ASSISTANT_ID,
          name: `tg:${chatId}`
        })
      });

      const s = await sResp.json();
      console.log("SESSION RES", sResp.status, s);

      sessionId = s?.id;
      if (sessionId) sessions.set(chatId, sessionId);
    }

    // 2) Vapi chat
    const chatResp = await fetch("https://api.vapi.ai/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VAPI_PRIVATE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        assistantId: VAPI_ASSISTANT_ID,
        sessionId,
        input: text
      })
    });

    const chat = await chatResp.json();
    console.log("CHAT RES", chatResp.status, chat);

    // 3) reply
    const reply =
      (Array.isArray(chat?.output) &&
        chat.output.map((o) => o?.content).filter(Boolean).join("\n")) ||
      chat?.output?.[0]?.content ||
      chat?.text ||
      chat?.message ||
      "Vapi nevrátilo textovou odpověď.";

    // 4) Telegram odpověď
    const tgResp = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: reply })
      }
    );

    const tg = await tgResp.json();
    console.log("TELEGRAM SEND RES", tgResp.status, tg);

    return res.sendStatus(200);
  } catch (e) {
    console.error("ERROR", e);
    return res.sendStatus(200);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port));
