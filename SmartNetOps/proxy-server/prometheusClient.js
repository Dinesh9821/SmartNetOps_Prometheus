"use strict";

/**
 * Reusable Prometheus HTTP API client.
 * All PromQL stays in the backend; the browser never talks to Prometheus.
 */

const DEFAULT_BASE = process.env.PROMETHEUS_URL || "http://cussya5x.carcgl.com:9090";
const DEFAULT_TIMEOUT_MS = Number(process.env.PROMETHEUS_TIMEOUT_MS || 12000);

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
    this.baseUrl = String(opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.fetchFn = opts.fetchFn || globalThis.fetch.bind(globalThis);
  }

  async _get(path, params) {
    const url = `${this.baseUrl}${path}?${encode(params)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
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

module.exports = {
  PrometheusClient,
  PrometheusError,
  samples,
  sampleValue,
  scalarFrom,
  maxFrom,
  avgFrom,
  DEFAULT_BASE
};
