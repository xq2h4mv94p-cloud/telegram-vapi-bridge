import express from "express";

const app = express();
app.use(express.json());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Pokud chceš stále textové dotazy posílat do Vapi:
const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;
const sessions = new Map(); // chatId -> vapiSessionId

app.get("/", (req, res) => res.send("ok"));

async function telegramApi(method, body) {
  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return await resp.json();
}

async function getTelegramFileBytes(fileId) {
  // 1) getFile -> file_path
  const info = await telegramApi("getFile", { file_id: fileId });
  const filePath = info?.result?.file_path;
  if (!filePath) throw new Error("Telegram getFile did not return file_path");

  // 2) download bytes
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to download file: ${r.status}`);
  const arrayBuffer = await r.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function analyzeWithGemini({ imageBytes, prompt }) {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");

  // Gemini REST: models/gemini-1.5-flash
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt || "Popiš, co je na obrázku. Pokud je tam text, přepiš ho. Pokud je to problém, navrhni řešení." },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: imageBytes.toString("base64")
                }
              }
            ]
          }
        ]
      })
    }
  );

  const data = await resp.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join("\n") ||
    data?.error?.message ||
    JSON.stringify(data);

  return text;
}

async function chatWithVapi({ chatId, text }) {
  if (!VAPI_PRIVATE_KEY || !VAPI_ASSISTANT_ID) {
    return "Text chat přes Vapi není nakonfigurovaný (chybí VAPI_PRIVATE_KEY nebo VAPI_ASSISTANT_ID).";
  }

  let sessionId = sessions.get(chatId);
  if (!sessionId) {
    const sResp = await fetch("https://api.vapi.ai/session", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VAPI_PRIVATE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ assistantId: VAPI_ASSISTANT_ID, name: `tg:${chatId}` })
    });
    const s = await sResp.json();
    sessionId = s?.id;
    if (sessionId) sessions.set(chatId, sessionId);
  }

  const cResp = await fetch("https://api.vapi.ai/chat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VAPI_PRIVATE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sessionId, input: text })
  });
  const chat = await cResp.json();

  return (
    (Array.isArray(chat?.output) && chat.output.map(o => o?.content).filter(Boolean).join("\n")) ||
    chat?.message ||
    "Vapi nevrátilo odpověď."
  );
}

app.post("/telegram", async (req, res) => {
  try {
    const msg = req.body?.message;
    const chatId = msg?.chat?.id;

    if (!chatId) return res.sendStatus(200);

    // 1) Pokud je fotka
    if (Array.isArray(msg?.photo) && msg.photo.length > 0) {
      // Telegram posílá více velikostí, vezmeme největší
      const best = msg.photo[msg.photo.length - 1];
      const fileId = best.file_id;

      const caption = msg.caption || ""; // text k fotce
      const bytes = await getTelegramFileBytes(fileId);
      const analysis = await analyzeWithGemini({
        imageBytes: bytes,
        prompt: caption || "Popiš, co je na obrázku. Pokud je tam text, přepiš ho."
      });

      await telegramApi("sendMessage", { chat_id: chatId, text: analysis });
      return res.sendStatus(200);
    }

    // 2) Jinak text -> Vapi (nebo sem můžeš dát i Gemini text model)
    const text = msg?.text;
    if (text) {
      const reply = await chatWithVapi({ chatId, text });
      await telegramApi("sendMessage", { chat_id: chatId, text: reply });
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("ERROR", e);
    return res.sendStatus(200);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port));
