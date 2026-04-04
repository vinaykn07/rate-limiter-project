"use strict";

const express    = require("express");
const rateLimiter     = require("./rateLimiter");
const adaptiveEngine  = require("./adaptiveEngine");

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(rateLimiter);

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({ message: "Request successful" });
});

/**
 * GET /sentinel/status
 * Returns a live diagnostic snapshot: current limits, last health score,
 * traffic signals, and engine configuration.
 */
app.get("/sentinel/status", (req, res) => {
  res.json(adaptiveEngine.getStatus());
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");

  // Start the adaptive engine's background observer loop
  adaptiveEngine.start();
});