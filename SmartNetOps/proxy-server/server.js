const express = require("express");
const request = require("request");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors()); // allow frontend to call proxy
const PROXY_BASE    = "http://cussya5w.carcgl.com:8080";  // set to your proxy host
const TOPOLOGY_API  = PROXY_BASE + "/proxy7";
const DISCOVERY_API = PROXY_BASE + "/proxy2";

// 🔥 Proxy endpoint
app.post("/proxy", (req, res) => {
  request(
    {
      url: "http://cussya5y.carcgl.com:7777/askLlm",
      method: "POST",
      json: req.body,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic ZGluZXNoOmRpbmVzaDEyMw=="
      }
    },
    (error, response, body) => {
      if (error) return res.status(500).json({ error });
      res.status(response.statusCode).json(body);
    }
  );
});

// Start server
app.listen(8080, () => console.log("🚀 Proxy running on http://localhost:8080/proxy"));





// API to get the site-id details.
app.post("/proxy1", (req, res) => {
  request(
    {
      url: "http://cussya5y.carcgl.com:7777/siteIdGet",
      method: "POST",
      json: req.body,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic ZGluZXNoOmRpbmVzaDEyMw=="
      }
    },
    (error, response, body) => {
      if (error) return res.status(500).json({ error });
      res.status(response.statusCode).json(body);
    }
  );
});


// Api to run first 4 workflow in Netautomation Flow

app.post("/proxy2", (req, res) => {
  request(
    {
      url: "http://cussya5y.carcgl.com:7777/aio",
      method: "POST",
      json: req.body,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic ZGluZXNoOmRpbmVzaDEyMw=="
      }
    },
    (error, response, body) => {
      if (error) return res.status(500).json({ error });
      res.status(response.statusCode).json(body);
    }
  );
});

app.post("/proxy7", (req, res) => {
  request({
    url: "http://cussya61.carcgl.com:8001/api/topology",  // <-- change to where you deploy main.py
    method: "POST", json: req.body, timeout: 190000,
    headers: { "Content-Type": "application/json" }
  }, (error, response, body) => {
    if (error) return res.status(502).json({ error: String(error) });
    res.status(response.statusCode).json(body);
  });
});


// Api to get Info in backend

app.post("/proxy3", (req, res) => {
  request(
    {
      url: "http://cussya5y.carcgl.com:7777/updateData",
      method: "POST",
      json: req.body,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic ZGluZXNoOmRpbmVzaDEyMw=="
      }
    },
    (error, response, body) => {
      if (error) return res.status(500).json({ error });
      res.status(response.statusCode).json(body);
    }
  );
});

//Api for Network diagram

app.post("/proxy4", async (req, res) => {
  try {
    const response = await fetch("http://cussya61.carcgl.com:5000/api/network-diagram", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "image/png"
      },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      return res.status(response.status).send(`Backend API error: ${response.statusText}`);
    }

    // Get the image as buffer
    const imageBuffer = await response.arrayBuffer();

    // Set correct headers
    res.setHeader("Content-Type", response.headers.get("content-type") || "image/png");
    res.setHeader("Access-Control-Allow-Origin", "*"); // Add CORS if needed
    res.setHeader("Content-Length", imageBuffer.byteLength);

    // Send the image buffer
    res.status(200).send(Buffer.from(imageBuffer));

  } catch (error) {
    console.error("Proxy error:", error);
    res.status(500).send(`Proxy error: ${error.message}`);
  }
});

// Add OPTIONS handler for CORS preflight
app.options("/proxy4", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.status(200).end();
});

// ---------------------------------------------------------------------------
// Site monitoring — Prometheus queries stay on the backend.
// Frontend sends site_id only (never PromQL).
// ---------------------------------------------------------------------------
const {
  validateSiteId,
  getSiteSnapshot,
  getSiteSeries,
  RANGE_WINDOWS
} = require("./monitoringService");

function sendMonitoringError(res, status, message, extra) {
  res.status(status).json(Object.assign({
    error: message,
    overall_status: "UNKNOWN"
  }, extra || {}));
}

async function handleMonitoringSnapshot(req, res) {
  const raw = req.params.siteId || req.query.site_id || req.body && req.body.site_id;
  const check = validateSiteId(raw);
  if (!check.ok) return sendMonitoringError(res, 400, check.error, { site_id: raw || null });
  try {
    const data = await getSiteSnapshot(check.siteId);
    if (data.prometheus_unavailable) {
      return res.status(503).json(data);
    }
    return res.json(data);
  } catch (err) {
    return sendMonitoringError(res, 503, "Monitoring data temporarily unavailable", {
      site_id: check.siteId,
      detail: String(err.message || err)
    });
  }
}

async function handleMonitoringSeries(req, res) {
  const raw = req.params.siteId || req.query.site_id;
  const check = validateSiteId(raw);
  if (!check.ok) return sendMonitoringError(res, 400, check.error, { site_id: raw || null });
  const range = req.query.range || "1h";
  if (!RANGE_WINDOWS[range]) {
    return sendMonitoringError(res, 400, "Invalid range", {
      allowed: Object.keys(RANGE_WINDOWS)
    });
  }
  try {
    const data = await getSiteSeries(check.siteId, range);
    return res.json(data);
  } catch (err) {
    return sendMonitoringError(res, 503, "Monitoring data temporarily unavailable", {
      site_id: check.siteId,
      detail: String(err.message || err)
    });
  }
}

app.get("/api/monitoring/:siteId/series", handleMonitoringSeries);
app.get("/api/monitoring/:siteId", handleMonitoringSnapshot);
app.get("/api/monitoring", handleMonitoringSnapshot);

const { getDashboard } = require("./dashboardService");

async function handleDashboard(req, res) {
  const raw = req.params.siteId || req.query.site_id || "";
  let siteId = "";
  if (raw) {
    const check = validateSiteId(raw);
    if (!check.ok) {
      return res.status(400).json({ error: check.error, site_id: raw, scope: "invalid" });
    }
    siteId = check.siteId;
  }
  try {
    const data = await getDashboard(siteId);
    if (data.error && data.scope === "invalid") {
      return res.status(400).json(data);
    }
    if (data.prometheus_unavailable) {
      return res.status(503).json(data);
    }
    return res.json(data);
  } catch (err) {
    return res.status(503).json({
      error: "Monitoring data temporarily unavailable",
      scope: siteId ? "site" : "global",
      site_id: siteId || null,
      detail: String(err.message || err)
    });
  }
}

app.get("/api/dashboard/:siteId", handleDashboard);
app.get("/api/dashboard", handleDashboard);

