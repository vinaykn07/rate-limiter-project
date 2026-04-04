"use strict";

const redis = require("./redis");
const { getLimits, recordRequest } = require("./adaptiveEngine");

module.exports = async (req, res, next) => {
  try {
    const ip  = req.ip;
    const key = `rate_limit:${ip}`;

    // Read the currently active limits from the adaptive engine
    const { maxRequests, windowSize } = getLimits();

    const requestCount = await redis.incr(key);

    if (requestCount === 1) {
      await redis.expire(key, windowSize);
    }

    if (requestCount > maxRequests) {
      // Record this as a blocked request before responding
      await recordRequest(true);
      return res.status(429).json({
        message: "Too many requests. Try again later.",
        retryAfter: windowSize,
      });
    }

    // Record allowed request
    await recordRequest(false);
    next();
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};