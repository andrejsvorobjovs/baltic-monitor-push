// Shared test helpers for the api/*.js endpoints that use @upstash/redis.
// Real Upstash Redis is a REST client whose exact wire protocol (path-style
// command encoding, base64 response encoding) isn't worth reproducing
// faithfully in a mock -- what actually needs testing is this project's
// own logic (rate limiting, validation, pruning, auth), not whether the
// Upstash SDK works. So this fakes the Redis *client surface* the handlers
// actually call (incr/expire/hlen/hset/hgetall/hdel) with a simple
// in-memory store instead, via node:test's mock.module() (requires the
// --experimental-test-module-mocks flag, already added to package.json's
// test script).
export class FakeRedis {
  constructor() {
    this.counters = new Map();
    this.hashes = new Map();
  }

  reset() {
    this.counters.clear();
    this.hashes.clear();
  }

  async incr(key) {
    const v = (this.counters.get(key) || 0) + 1;
    this.counters.set(key, v);
    return v;
  }

  async expire() {
    return 1;
  }

  async hlen(key) {
    const h = this.hashes.get(key);
    return h ? h.size : 0;
  }

  async hset(key, obj) {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    for (const [k, v] of Object.entries(obj)) h.set(k, v);
    return Object.keys(obj).length;
  }

  async hgetall(key) {
    const h = this.hashes.get(key);
    if (!h) return null;
    return Object.fromEntries(h);
  }

  async hdel(key, ...fields) {
    const h = this.hashes.get(key);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) {
      if (h.delete(f)) n++;
    }
    return n;
  }
}

// A constructor whose `new Redis(...)` returns the given fake instance
// instead of a real client -- passed as the `Redis` named export to
// mock.module("@upstash/redis", { namedExports: { Redis: ... } }).
export function fakeRedisConstructor(instance) {
  return class {
    constructor() {
      return instance;
    }
  };
}

// Minimal fake of the Vercel serverless response object, covering every
// method actually used across api/*.js: status/json (all), setHeader/send
// (admin.js, status.js), writeHead/end (admin.js's POST redirect), end
// alone (subscribe.js's OPTIONS 204).
export function makeRes() {
  return {
    statusCode: undefined,
    body: undefined,
    headers: {},
    redirectLocation: undefined,
    ended: false,
    status(c) {
      this.statusCode = c;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
    writeHead(c, h) {
      this.statusCode = c;
      if (h) Object.assign(this.headers, h);
      if (h && h.Location) this.redirectLocation = h.Location;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}
