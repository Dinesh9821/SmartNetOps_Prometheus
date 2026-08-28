"use strict";

/**
 * Reusable Prometheus HTTP API client.
 * All PromQL stays in the backend; the browser never talks to Prometheus.
 */

function splitBases(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function defaultCandidateBases() {
  if (process.env.PROMETHEUS_URL) return splitBases(process.env.PROMETHEUS_URL);
  return [
    "http://127.0.0.1:9090",
    "http://localhost:9090",
    "http://cussya5x.carcgl.com:9090",
    "http://cussya5w.carcgl.com:9090"
  ];
}

const DEFAULT_BASE = defaultCandidateBases()[0];
const DEFAULT_TIMEOUT_MS = Number(process.env.PROMETHEUS_TIMEOUT_MS || 12000);

function isLoopback(base) {
  return /127\.0\.0\.1|localhost/i.test(base);
}

function PrometheusError(message, code, extra) {
  const err = new Error(message);
  err.code = code || "PROM_ERROR";
  err.extra = extra;
  return err;
}

function encode(params) {
  const q = new URLSearchParams();
  Object.keys(params).forEach((k) => {
    if (params[k] !== undefined && params[k] !== null) q.set(k, String(params[k]));
  });
  return q.toString();
}

class PrometheusClient {
  constructor(opts) {
    opts = opts || {};
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.fetchFn = opts.fetchFn || globalThis.fetch.bind(globalThis);
    if (opts.baseUrl) {
      this.candidates = [String(opts.baseUrl).replace(/\/+$/, "")];
      this._pinned = true;
    } else if (opts.candidates && opts.candidates.length) {
      this.candidates = opts.candidates.map((s) => String(s).replace(/\/+$/, ""));
      this._pinned = false;
    } else {
      this.candidates = defaultCandidateBases();
      this._pinned = false;
    }
    this.baseUrl = this.candidates[0];
  }

  async _getOnce(baseUrl, path, params) {
    const url = `${baseUrl}${path}?${encode(params)}`;
    const ctrl = new AbortController();
    const timeoutMs = isLoopback(baseUrl) ? Math.min(this.timeoutMs, 2500) : this.timeoutMs;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: ctrl.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw PrometheusError(
          `Prometheus HTTP ${res.status}`,
          "PROM_HTTP",
          { status: res.status, body: text.slice(0, 400) }
        );
      }
      const body = await res.json();
      if (body.status !== "success") {
        throw PrometheusError(
          body.error || "Prometheus query failed",
          "PROM_QUERY",
          body
        );
      }
      return body.data;
    } catch (err) {
      if (err.name === "AbortError") {
        throw PrometheusError("Prometheus request timed out", "PROM_TIMEOUT");
      }
      if (err.code) throw err;
      throw PrometheusError(
        "Monitoring data temporarily unavailable",
        "PROM_UNAVAILABLE",
        { cause: String(err.message || err) }
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async _get(path, params) {
    const list = this._pinned ? [this.baseUrl] : this.candidates;
    let lastErr;
    for (let i = 0; i < list.length; i++) {
      const base = list[i];
      try {
        const data = await this._getOnce(base, path, params);
        this.baseUrl = base;
        this._pinned = true;
        return data;
      } catch (err) {
        lastErr = err;
        if (err.code === "PROM_HTTP" || err.code === "PROM_QUERY") throw err;
      }
    }
    throw lastErr || PrometheusError("Monitoring data temporarily unavailable", "PROM_UNAVAILABLE");
  }

  async query(expr) {
    const data = await this._get("/api/v1/query", { query: expr });
    return data.result || [];
  }

  async queryRange(expr, start, end, step) {
    const data = await this._get("/api/v1/query_range", {
      query: expr,
      start,
      end,
      step
    });
    return data.result || [];
  }

  async queryMany(namedExprs, concurrency) {
    const entries = Object.entries(namedExprs);
    const limit = Math.max(1, concurrency || 8);
    const out = {};
    let i = 0;

    const worker = async () => {
      while (i < entries.length) {
        const idx = i++;
        const [name, expr] = entries[idx];
        try {
          out[name] = { ok: true, result: await this.query(expr) };
        } catch (err) {
          out[name] = {
            ok: false,
            error: err.message,
            code: err.code,
            result: []
          };
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker));
    return out;
  }
}

function sampleValue(series) {
  if (!series || !series.value) return null;
  const v = series.value[1];
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function samples(result) {
  return (result || []).map((s) => ({
    metric: s.metric || {},
    value: sampleValue(s),
    ts: s.value ? Number(s.value[0]) : null
  })).filter((s) => s.value !== null);
}

function scalarFrom(result) {
  const list = samples(result);
  if (!list.length) return null;
  return list.reduce((acc, s) => acc + s.value, 0);
}

function maxFrom(result) {
  const list = samples(result);
  if (!list.length) return null;
  return list.reduce((acc, s) => Math.max(acc, s.value), -Infinity);
}

function avgFrom(result) {
  const list = samples(result);
  if (!list.length) return null;
  return list.reduce((acc, s) => acc + s.value, 0) / list.length;
}

function latestTsFromResults(named) {
  let max = null;
  Object.values(named || {}).forEach((entry) => {
    const result = entry && entry.result;
    (result || []).forEach((s) => {
      if (s.value && s.value[0] != null) {
        const t = Number(s.value[0]);
        if (Number.isFinite(t) && (max == null || t > max)) max = t;
      }
      (s.values || []).forEach((pair) => {
        const t = Number(pair && pair[0]);
        if (Number.isFinite(t) && (max == null || t > max)) max = t;
      });
    });
  });
  return max;
}

function isoFromUnix(ts) {
  if (ts == null || !Number.isFinite(Number(ts))) return null;
  return new Date(Number(ts) * 1000).toISOString();
}

module.exports = {
  PrometheusClient,
  PrometheusError,
  samples,
  sampleValue,
  scalarFrom,
  maxFrom,
  avgFrom,
  latestTsFromResults,
  isoFromUnix,
  DEFAULT_BASE,
  defaultCandidateBases
};
