/**
 * adaptiveEngine.js — Sentinel Dynamic Rate Limit Engine
 *
 * Every OBSERVE_INTERVAL seconds this module:
 *   1. Reads traffic counters (total requests, blocked requests)
 *   2. Computes a Traffic Health Score (0–100) from two signals:
 *        - Block Rate  : blocked / total          → contributes 0–60 pts
 *        - Velocity    : req/s vs ceiling          → contributes 0–40 pts
 *   3. Maps the score to a tier and nudges MAX_REQUESTS / WINDOW_SIZE:
 *        🟢 Healthy   (score ≥ 70) → relax limits
 *        🟡 Moderate  (30–69)      → hold limits
 *        🔴 Stressed  (score < 30) → tighten limits
 */

"use strict";
 
const redis = require("./redis");

// ─── Constants ────────────────────────────────────────────────────────────────

const OBSERVE_INTERVAL    = 10;   // seconds between each observation cycle
const VELOCITY_CEILING    = 10;   // req/s above which velocity score degrades to 0
const RELAX_ON_IDLE       = true; // relax limits when traffic is near-zero

const DEFAULT_MAX_REQUESTS = 3;
const DEFAULT_WINDOW_SIZE  = 5;   // seconds

const MIN_MAX_REQUESTS = 1;
const MAX_MAX_REQUESTS = 20;
const MIN_WINDOW_SIZE  = 2;       // seconds
const MAX_WINDOW_SIZE  = 30;      // seconds

const HEALTHY_THRESHOLD  = 70;
const STRESSED_THRESHOLD = 30;

// Redis counter keys (global, not per-IP)
const KEY_TOTAL   = "sentinel:total";
const KEY_BLOCKED = "sentinel:blocked";

// ─── Mutable State ────────────────────────────────────────────────────────────

let currentMaxRequests = DEFAULT_MAX_REQUESTS;
let currentWindowSize  = DEFAULT_WINDOW_SIZE;
let lastHealthScore    = 100;
let lastTier           = "Healthy";
let lastVelocity       = 0;
let lastBlockRate      = 0;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the currently active rate-limit parameters.
 * Called by rateLimiter.js on every incoming request.
 */
function getLimits() {
  return {
    maxRequests: currentMaxRequests,
    windowSize:  currentWindowSize,
  };
}

/**
 * Returns a full diagnostic snapshot for the /sentinel/status endpoint.
 */
function getStatus() {
  return {
    currentLimits: {
      maxRequests: currentMaxRequests,
      windowSize:  currentWindowSize,
    },
    lastCycle: {
      healthScore: lastHealthScore,
      tier:        lastTier,
      blockRate:   `${(lastBlockRate * 100).toFixed(1)}%`,
      velocity:    `${lastVelocity.toFixed(2)} req/s`,
    },
    bounds: {
      maxRequests: { min: MIN_MAX_REQUESTS, max: MAX_MAX_REQUESTS },
      windowSize:  { min: MIN_WINDOW_SIZE,  max: MAX_WINDOW_SIZE },
    },
    config: {
      observeIntervalSeconds: OBSERVE_INTERVAL,
      velocityCeilingReqPerSec: VELOCITY_CEILING,
      relaxOnIdle: RELAX_ON_IDLE,
    },
  };
}

/**
 * Increments the global traffic counters in Redis.
 * Must be called by rateLimiter.js for every request.
 *
 * @param {boolean} wasBlocked - true if the request was rate-limited (429)
 */
async function recordRequest(wasBlocked) {
  try {
    // Fire-and-forget pipeline for minimum latency impact
    const pipeline = redis.pipeline();
    pipeline.incr(KEY_TOTAL);
    if (wasBlocked) pipeline.incr(KEY_BLOCKED);
    await pipeline.exec();
  } catch (err) {
    // Never crash the middleware over a counter failure
    console.error("[Sentinel] recordRequest error:", err.message);
  }
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Clamps `value` between `min` and `max`.
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Computes the 0–100 Traffic Health Score.
 *
 *   blockRateScore = (1 - blockRate) * 60       → 0–60 pts
 *   velocityScore  = (1 - velocity/ceiling) * 40 → 0–40 pts
 *   healthScore    = blockRateScore + velocityScore
 *
 * @param {number} total   - total requests in the last window
 * @param {number} blocked - blocked requests in the last window
 * @returns {{ score: number, velocity: number, blockRate: number }}
 */
function computeHealthScore(total, blocked) {
  if (total === 0) {
    // No traffic at all
    const idleScore = RELAX_ON_IDLE ? 100 : 50;
    return { score: idleScore, velocity: 0, blockRate: 0 };
  }

  const blockRate = clamp(blocked / total, 0, 1);
  const velocity  = total / OBSERVE_INTERVAL;            // req/s

  const blockRateScore = (1 - blockRate) * 60;
  const velocityScore  = clamp(1 - velocity / VELOCITY_CEILING, 0, 1) * 40;

  const score = Math.round(blockRateScore + velocityScore);

  return { score, velocity, blockRate };
}

// ─── Adjustment ───────────────────────────────────────────────────────────────

/**
 * Nudges limits up or down by 1 step based on the health tier.
 * Incremental changes prevent violent oscillation between bursts.
 *
 * 🟢 Healthy  → MAX_REQUESTS +1, WINDOW_SIZE stays or -1 (more permissive)
 * 🟡 Moderate → no change
 * 🔴 Stressed → MAX_REQUESTS -1, WINDOW_SIZE stays (tighter cap)
 */
function adjustLimits(score) {
  let tier;

  if (score >= HEALTHY_THRESHOLD) {
    tier = "Healthy";
    currentMaxRequests = clamp(currentMaxRequests + 1, MIN_MAX_REQUESTS, MAX_MAX_REQUESTS);
    // Shrink window slightly when healthy so the bucket refills faster
    currentWindowSize  = clamp(currentWindowSize - 1, MIN_WINDOW_SIZE, MAX_WINDOW_SIZE);
  } else if (score >= STRESSED_THRESHOLD) {
    tier = "Moderate";
    // Hold — no adjustment
  } else {
    tier = "Stressed";
    currentMaxRequests = clamp(currentMaxRequests - 1, MIN_MAX_REQUESTS, MAX_MAX_REQUESTS);
    // Keep window at current size; reducing reqs/window is enough
  }

  return tier;
}

// ─── Observer Loop ────────────────────────────────────────────────────────────

/**
 * One observation cycle:
 *   1. Atomically snapshot+reset the Redis counters (GETDEL)
 *   2. Score the snapshot
 *   3. Adjust limits
 *   4. Log the result
 */
async function runObservationCycle() {
  try {
    // Atomically read and reset both counters so each cycle is a clean slate.
    // GETDEL is available in Redis ≥ 4.0 and ioredis supports it natively.
    const [[, totalStr], [, blockedStr]] = await redis
      .pipeline()
      .getdel(KEY_TOTAL)
      .getdel(KEY_BLOCKED)
      .exec();

    const total   = parseInt(totalStr   ?? "0", 10);
    const blocked = parseInt(blockedStr ?? "0", 10);

    const { score, velocity, blockRate } = computeHealthScore(total, blocked);
    const tier = adjustLimits(score);

    // Persist for status endpoint
    lastHealthScore = score;
    lastTier        = tier;
    lastVelocity    = velocity;
    lastBlockRate   = blockRate;

    const tierEmoji = { Healthy: "🟢", Moderate: "🟡", Stressed: "🔴" }[tier];
    console.log(
      `[Sentinel] Health: ${score}/100 | Block: ${(blockRate * 100).toFixed(1)}% | ` +
      `Velocity: ${velocity.toFixed(2)} req/s → ${tierEmoji} ${tier} ` +
      `— limits (MAX=${currentMaxRequests}, WIN=${currentWindowSize}s)`
    );
  } catch (err) {
    console.error("[Sentinel] Observation cycle error:", err.message);
  }
}

/**
 * Starts the background observation loop.
 * Call once from index.js after the server starts.
 */
function start() {
  console.log(
    `[Sentinel] Adaptive engine started — observing every ${OBSERVE_INTERVAL}s ` +
    `(defaults: MAX=${DEFAULT_MAX_REQUESTS}, WIN=${DEFAULT_WINDOW_SIZE}s)`
  );
  // Run the first cycle immediately, then every OBSERVE_INTERVAL seconds
  runObservationCycle();
  setInterval(runObservationCycle, OBSERVE_INTERVAL * 1000);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { start, getLimits, getStatus, recordRequest };
