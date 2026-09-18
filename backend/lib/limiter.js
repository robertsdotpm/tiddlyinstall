// Per-address sliding-window rate limits (the Go server's limiter): at most
// n calls in `window` milliseconds from one address.
export class Limiter {
  constructor(n, windowMs) {
    this.n = n;
    this.window = windowMs;
    this.hits = new Map();
  }

  allow(ip, now = Date.now()) {
    const keep = (this.hits.get(ip) || []).filter((t) => now - t < this.window);
    if (keep.length >= this.n) {
      this.hits.set(ip, keep);
      return false;
    }
    keep.push(now);
    this.hits.set(ip, keep);
    // Forget addresses that have gone quiet, so the map can't grow forever.
    if (this.hits.size > 10000) {
      for (const [k, ts] of this.hits) {
        if (!ts.length || now - ts[ts.length - 1] > this.window) this.hits.delete(k);
      }
    }
    return true;
  }
}
