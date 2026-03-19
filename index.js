import "dotenv/config";
import express from "express";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
const port = 3000;

// ─── 0. Setup Database Directories ──────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), "data");
const CHUNKS_DIR = path.join(DATA_DIR, "chunks");
const BOOKS_DB = path.join(DATA_DIR, "books.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(CHUNKS_DIR)) fs.mkdirSync(CHUNKS_DIR);
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

// Basic JSON DB Helper
function getBooks() {
  if (!fs.existsSync(BOOKS_DB)) return [];
  return JSON.parse(fs.readFileSync(BOOKS_DB, "utf8"));
}
function saveBook(book) {
  const books = getBooks();
  books.push(book);
  fs.writeFileSync(BOOKS_DB, JSON.stringify(books, null, 2));
}

// ─── 1. Middlewares ─────────────────────────────────────────────────────────
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use(express.static("public"));
app.use(express.json());
app.use("/chat", limiter);
app.use("/admin/upload", limiter);

// Multer Disk Storage
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

// Multi-User Sessions (For Chat History only)
const sessions = new Map();

// RAG Algorithm
function getTopChunks(query, chunks, topK = 7) {
  const queryWords = query.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(w => w.length > 3);
  if (queryWords.length === 0) return chunks.slice(0, topK);

  const scored = chunks.map(chunk => {
    let score = 0;
    const chunkLower = chunk.toLowerCase();
    for (const word of queryWords) {
      score += chunkLower.split(word).length - 1;
    }
    return { chunk, score };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, topK).map(s => s.chunk);
}

// ─── 2. Endpoints ───────────────────────────────────────────────────────────

// Public: Get Library Catalogue
app.get("/books", (req, res) => {
  res.json(getBooks());
});

// Admin: Upload Book Pipeline
app.post("/admin/upload", upload.single("pdf"), async (req, res) => {
  const { title, description } = req.body;
  
  if (!title || !description || !req.file) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "Missing title, description, or file." });
  }

  try {
    const filePath = path.join(process.cwd(), req.file.path);
    
    // Parse PDF
    const parser = new PDFParse({ data: fs.readFileSync(filePath) });
    const result = await parser.getText();
    await parser.destroy();
    fs.unlinkSync(filePath); // Cleanup

    // Chunking text
    const docChunks = [];
    for (const page of result.pages) {
      const paragraphs = page.text.split(/\n\s*\n/);
      for (const para of paragraphs) {
        if (para.trim().length > 40) {
          docChunks.push(`[Page ${page.num}] ${para.trim().replace(/\n/g, ' ')}`);
        }
      }
    }

    // Save Chunks to Disk persistently
    const bookId = crypto.randomUUID();
    const chunkPath = path.join(CHUNKS_DIR, `${bookId}.json`);
    fs.writeFileSync(chunkPath, JSON.stringify(docChunks));

    // Save Metadata to DB
    const newBook = {
      id: bookId,
      title: title.trim(),
      description: description.trim(),
      filename: req.file.originalname,
      pages: result.total,
      chunkCount: docChunks.length,
      createdAt: new Date().toISOString()
    };
    saveBook(newBook);

    res.json({ success: true, book: newBook });
  } catch (err) {
    console.error("Admin upload error:", err);
    res.status(500).json({ error: "Failed to parse and store PDF." });
  }
});

// Public: Streaming Chat
app.get("/chat", async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  const { message, bookId } = req.query;
  
  if (!sessionId || !message || !bookId) return res.end();

  try {
    // Load Specific Book Chunks
    const chunkPath = path.join(CHUNKS_DIR, `${bookId}.json`);
    if (!fs.existsSync(chunkPath)) {
      res.write("data: " + JSON.stringify({ error: "Book not found in database." }) + "\n\n");
      return res.end();
    }
    const chunks = JSON.parse(fs.readFileSync(chunkPath, "utf8"));

    // Ensure session exists
    if (!sessions.has(sessionId)) sessions.set(sessionId, { history: [] });
    const session = sessions.get(sessionId);

    // Apply RAG Context
    const bestChunks = getTopChunks(message, chunks, 7);
    const ragContext = bestChunks.join("\n\n");

    const systemMessage = {
      role: "system",
      content: `You are an expert Q&A system for the current document. Answer using ONLY the snippets provided below.
Always cite the matching [Page N] in your answer.
If the snippets do not contain the answer, reply "I cannot find the answer in the document."

--- DOCUMENT SNIPPETS ---
${ragContext}
--- END ---`
    };

    const currentMessages = [
      systemMessage,
      ...session.history,
      { role: "user", content: message }
    ];

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const ollamaRequest = await fetch("https://ollama.com/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` },
      body: JSON.stringify({ model: "qwen3.5:cloud", messages: currentMessages, stream: true }),
    });

    let fullReply = "";
    const decoder = new TextDecoder();

    for await (const chunk of ollamaRequest.body) {
      const lines = decoder.decode(chunk).split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          if (json.message?.content) {
            fullReply += json.message.content;
            res.write(`data: ${JSON.stringify({ chunk: json.message.content })}\n\n`);
          }
        } catch { }
      }
    }

    session.history.push({ role: "user", content: message });
    session.history.push({ role: "assistant", content: fullReply });
    if (session.history.length > 6) {
      session.history = session.history.slice(session.history.length - 6);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    console.error("Chat error:", error);
    res.write("data: " + JSON.stringify({ error: "API connection failed" }) + "\n\n");
    res.end();
  }
});

app.listen(port, () => {
  console.log(`\n🚀 Server is running at http://localhost:${port}`);
  console.log(`📚 Public Library Hub ready at /`);
  console.log(`⚙️  Admin Portal ready at /admin.html\n`);
});