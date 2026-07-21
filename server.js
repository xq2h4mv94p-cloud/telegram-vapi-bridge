import express from "express";

const app = express();
app.use(express.json());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Nastav v Render env varu, až uvidíš seznam modelů:
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

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

// ListModels helper (debug)
app.get("/gemini-models", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(400).json({ error: "Missing GEMINI_API_KEY" });

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`
    );
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

async function analyzeWithGemini({ imageBytes, prompt }) {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");

  // IMPORTANT: model name must be prefixed with "models/"
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

  return { status: resp.status, text, raw: data };
}

app.get("/", (req, res) => res.send("ok"));

app.post("/telegram", async (req, res) => {
  try {
    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    if (!chatId) return res.sendStatus(200);

    if (Array.isArray(msg?.photo) && msg.photo.length > 0) {
      const best = msg.photo[msg.photo.length - 1];
      const fileId = best.file_id;

      const caption = msg.caption || "";
      const bytes = await getTelegramFileBytes(fileId);

      const result = await analyzeWithGemini({
        imageBytes: bytes,
        prompt: caption || "Popiš, co je na obrázku. Pokud je tam text, přepiš ho."
      });

      await telegramApi("sendMessage", { chat_id: chatId, text: result.text });
      return res.sendStatus(200);
    }

    // Pokud chceš text přes Gemini taky, dá se doplnit; zatím jen info:
    if (msg?.text) {
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: "Pošli fotku (nebo fotku s popiskem) a já ji zanalyzuju přes Gemini."
      });
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("ERROR", e);
    return res.sendStatus(200);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port, "model:", GEMINI_MODEL));
