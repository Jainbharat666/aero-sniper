import app from '../server.js';

export default function handler(req, res) {
  const matched = req.headers['x-matched-path'] || req.headers['x-now-route-matches'];
  if (matched && matched.startsWith('/api')) {
    req.url = matched;
  }
  return app(req, res);
}
