import express from "express";

const app = express();
app.use(express.json());

// ✅ CORS for Base44 (so browser calls work)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "brain" });
});

// MAIN AGENT ENDPOINT
app.post("/api/agent/chat", async (req, res) => {
  const { message, conversation_id } = req.body || {};
  const text = (message || "").toString().trim();

  if (!text) {
    return res.status(400).json({ reply: "Send me a message and I’ll reply.", suggested_actions: [] });
  }

  // IMPORTANT:
  // Do NOT include debug phrases like "Agent here. I received:" or Base44 will hide it.
  // For now, return a normal reply so you SEE it in the UI.
  return res.json({
    reply: `Got it 👍 You said: "${text}". What do you want help with next — training, matches, or career plan?`,
    suggested_actions: [
      { id: "training", label: "Go to Training", intent: "navigate:training" },
      { id: "matches", label: "View Next Match", intent: "navigate:matches" },
    ],
    conversation_id: conversation_id || "conv",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Brain API running on port", PORT));
