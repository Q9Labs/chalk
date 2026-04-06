const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")

const PORT = Number(process.env.PORT || 8789)
const audioPath = process.env.AUDIO_PATH
const callbackLogPath = process.env.CALLBACK_LOG_PATH || "/tmp/chalk-worker-probe-callback.json"

if (!audioPath) {
  throw new Error("AUDIO_PATH is required")
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/audio.mp4") {
    res.writeHead(200, { "content-type": "video/mp4" })
    fs.createReadStream(audioPath).pipe(res)
    return
  }

  if (req.method === "GET" && req.url === "/audio-as-audio.mp4") {
    res.writeHead(200, { "content-type": "audio/mp4" })
    fs.createReadStream(audioPath).pipe(res)
    return
  }

  if (req.method === "POST" && req.url === "/callback") {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      const payload = {
        at: new Date().toISOString(),
        headers: req.headers,
        body,
      }
      fs.writeFileSync(callbackLogPath, JSON.stringify(payload, null, 2))
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    })
    return
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, audioPath: path.basename(audioPath) }))
    return
  }

  res.writeHead(404, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: "not found" }))
})

server.listen(PORT, () => {
  console.log(`worker probe server listening on ${PORT}`)
})
