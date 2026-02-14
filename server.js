import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory conversation history (keyed by conversation_id)
const conversations = new Map();

// Health check (Render + Base44 diagnostics)
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "brain" });
});

// MAIN AGENT ENDPOINT
app.post("/api/agent/chat", async (req, res) => {
  const { message, conversation_id } = req.body || {};

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  const convId = conversation_id || `conv_${Date.now()}`;

  // Retrieve or start conversation history
  if (!conversations.has(convId)) {
    conversations.set(convId, [
      {
        role: "system",
        content:
          "You are a helpful AI assistant. Be concise and friendly in your responses.",
      },
    ]);
  }

  const history = conversations.get(convId);
  history.push({ role: "user", content: message });

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: history,
    });

    const reply = completion.choices[0].message.content;
    history.push({ role: "assistant", content: reply });

    // Keep history from growing unbounded (last 50 messages + system prompt)
    if (history.length > 51) {
      conversations.set(convId, [history[0], ...history.slice(-50)]);
    }

    res.json({ reply, conversation_id: convId });
  } catch (err) {
    console.error("OpenAI error:", err.message);
    res.status(502).json({
      error: "Failed to get AI response",
      detail: err.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Brain API running on port", PORT);
});
