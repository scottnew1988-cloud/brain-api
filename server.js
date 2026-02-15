import express from "express";

const app = express();
app.use(express.json());

// Health check (Render + Base44 diagnostics)
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "brain" });
});

// MAIN AGENT ENDPOINT
app.post("/api/agent/chat", async (req, res) => {
  const { message, conversation_id } = req.body || {};

  res.json({
  reply: `🧠 Agent here. I received: "${message}". Your Brain API is now live.`,
  suggested_actions: [
    { id: "training", label: "Go to Training", intent: "navigate:training" },
    { id: "matches", label: "View Next Match", intent: "navigate:matches" }
  ],
  conversation_id: conversation_id || "conv"
});

});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🧠 Brain API running on port", PORT);
});

