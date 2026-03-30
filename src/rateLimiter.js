const redis = require("./redis");

const WINDOW_SIZE = 5; // seconds
const MAX_REQUESTS = 3;

module.exports = async (req, res, next) => {
  try {
    const ip = req.ip;
    const key = `rate_limit:${ip}`;

    const requestCount = await redis.incr(key);

    if (requestCount === 1) {
      await redis.expire(key, WINDOW_SIZE);
    }

    if (requestCount > MAX_REQUESTS) {
      return res.status(429).json({
        message: "Too many requests. Try again later.",
      });
    }

    next();
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};