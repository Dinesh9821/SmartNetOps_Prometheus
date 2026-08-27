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

