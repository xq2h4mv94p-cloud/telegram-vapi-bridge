import express from "express";

const app = express();
app.use(express.json());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-flash-lite-latest";

// chatId -> vapiSessionId
const sessions = new Map();

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
  const info = await telegramApi("getFile", { file_id: fileId });
  const filePath = info?.result?.file_path;
  if (!filePath) throw new Error("Telegram getFile did not return file_path");

  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to download file: ${r.status}`);
  const arrayBuffer = await r.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function pickImageFromTelegramMessage(msg) {
  // photo
  if (Array.isArray(msg?.photo) && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1];
    return { fileId: best.file_id, mimeType: "image/jpeg", source: "photo" };
  }
  // document (image/*)
  const doc = msg?.document;
  if (doc?.file_id) {
    const mt = doc.mime_type || "";
    if (mt.startsWith("image/")) {
      return { fileId: doc.file_id, mimeType: mt, source: "document" };
    }
  }
  return null;
}

async function analyzeWithGemini({ imageBytes, mimeType, prompt }) {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");

  const modelPath = GEMINI_MODEL.startsWith("models/") ? GEMINI_MODEL : `models/${GEMINI_MODEL}`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt || "Popiš, co je na obrázku. Pokud je tam text, přepiš ho." },
              {
                inlineData: {
                  mimeType: mimeType || "image/jpeg",
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

async function getOrCreateVapiSession(chatId) {
  let sessionId = sessions.get(chatId);
  if (sessionId) return sessionId;

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
  sessionId = s?.id;
  if (sessionId) sessions.set(chatId, sessionId);
  return sessionId;
}

async function vapiChat({ sessionId, input }) {
  const cResp = await fetch("https://api.vapi.ai/chat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VAPI_PRIVATE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sessionId, input })
  });

  const chat = await cResp.json();

  const reply =
    (Array.isArray(chat?.output) && chat.output.map(o => o?.content).filter(Boolean).join("\n")) ||
    chat?.message ||
    "Vapi nevrátilo odpověď.";

  return reply;
}

app.post("/telegram", async (req, res) => {
  try {
    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    if (!chatId) return res.sendStatus(200);

    if (!TELEGRAM_BOT_TOKEN || !VAPI_PRIVATE_KEY || !VAPI_ASSISTANT_ID) {
      await telegramApi("sendMessage", { chat_id: chatId, text: "Server není nakonfigurovaný (chybí env vars)." });
      return res.sendStatus(200);
    }

    const sessionId = await getOrCreateVapiSession(chatId);

    // IMAGE path
    const image = pickImageFromTelegramMessage(msg);
    if (image) {
      const bytes = await getTelegramFileBytes(image.fileId);
      const caption = msg.caption || "";
      const geminiText = await analyzeWithGemini({
        imageBytes: bytes,
        mimeType: image.mimeType,
        prompt: caption || "Popiš, co je na obrázku. Pokud je tam text, přepiš ho."
      });

      // Pošleme do Vapi jako textový kontext pro tvého agenta
      const input =
        `Uživatel poslal obrázek (zdroj: ${image.source}).\n` +
        (caption ? `Popisek od uživatele: ${caption}\n` : "") +
        `Gemini analýza obrázku:\n${geminiText}`;

      const reply = await vapiChat({ sessionId, input });
      await telegramApi("sendMessage", { chat_id: chatId, text: reply });
      return res.sendStatus(200);
    }

    // TEXT path
    if (msg?.text) {
      const reply = await vapiChat({ sessionId, input: msg.text });
      await telegramApi("sendMessage", { chat_id: chatId, text: reply });
      return res.sendStatus(200);
    }

    // other update types ignored
    return res.sendStatus(200);
  } catch (e) {
    console.error("ERROR", e);
    return res.sendStatus(200);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port));
