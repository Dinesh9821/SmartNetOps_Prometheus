const express = require("express");
const request = require("request");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors()); // allow frontend to call proxy


app.post("/proxy4", (req, res) => {
  request(
    {
      url: "http://161.145.120.189:5000/api/network-diagram",
      method: "POST",
      body: JSON.stringify(req.body),
      headers: {
        "Content-Type": "application/json",
        "Accept": "image/png"
      },
      encoding: null   // 🔑 CRITICAL: keep binary
    },
    (error, response, body) => {
      if (error) {
        return res.status(500).send(error.message);
      }

      // Forward correct content-type
      res.setHeader(
        "Content-Type",
        response.headers["content-type"] || "image/png"
      );

      // Send raw image bytes
      res.status(response.statusCode).send(body);
    }
  );
});
