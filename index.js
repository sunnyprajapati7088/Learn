import "dotenv/config";
import express from "express";
import multer from "multer";
import { PDFParse } from "pdf-parse";

const app = express();
const port = 3000;

// Setup static file serving
app.use(express.static("public"));
app.use(express.json());

// Setup multer for memory storage file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Global conversation context (In production, use sessions)
let currentPdfContext = "";
let messages = [];

// Endpoint: Upload PDF and extract text
app.post("/upload", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    // Parse the PDF
    const parser = new PDFParse({ data: req.file.buffer });
    const result = await parser.getText();
    await parser.destroy();

    // Create the labelled context per page
    currentPdfContext = result.pages
      .map((p) => `[Page ${p.num}]\n${p.text.trim()}`)
      .join("\n\n");

    const filename = req.file.originalname;

    // Reset conversation history with the new system context
    messages = [
      {
        role: "system",
        content: `You are an expert assistant for the document "${filename}".
The document is provided below, where each page starts with [Page N].

Rules:
- Always cite the correct page number(s) in your answer (e.g. "According to Page 3...").
- Say "This is not covered in the document" if the text does not contain the answer.
- Format your response clearly using markdown.
- Be concise.

--- DOCUMENT START ---
${currentPdfContext}
--- DOCUMENT END ---`,
      },
    ];

    res.json({ success: true, pages: result.total, filename });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Failed to parse PDF." });
  }
});

// Endpoint: Chat with streaming SSE
app.get("/chat", async (req, res) => {
  const userInput = req.query.message;
  if (!userInput) return res.end();

  if (!currentPdfContext) {
    res.write("data: " + JSON.stringify({ error: "Please upload a PDF first." }) + "\n\n");
    return res.end();
  }

  messages.push({ role: "user", content: userInput });

  // Server-Sent Events headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const ollamaRequest = await fetch("https://ollama.com/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
      },
      body: JSON.stringify({
        model: "qwen3.5:cloud",
        messages,
        stream: true,
      }),
    });

    let fullReply = "";
    const decoder = new TextDecoder();

    for await (const chunk of ollamaRequest.body) {
      const lines = decoder.decode(chunk).split("\n").filter((l) => l.trim() !== "");
      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          if (json.message?.content) {
            fullReply += json.message.content;
            res.write(`data: ${JSON.stringify({ chunk: json.message.content })}\n\n`);
          }
        } catch { /* skip incomplete chunks */ }
      }
    }

    messages.push({ role: "assistant", content: fullReply });
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    console.error("Chat error:", error);
    res.write("data: " + JSON.stringify({ error: "Failed to connect to AI API." }) + "\n\n");
    res.end();
  }
});

app.listen(port, () => {
  console.log(`\n🚀 Web UI Server is running!`);
  console.log(`🌍 Open your browser and go to: http://localhost:${port}`);
  console.log(`\nPress Ctrl+C to stop the server.`);
});