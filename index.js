import "dotenv/config";
import express from "express";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";

const app = express();
const port = 3005;

// ─── 0. Connect to MongoDB (Vercel Ready) ──────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.warn("⚠️ Warning: MONGO_URI is missing in .env! Database connection will fail.");
} else {
  mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected successfully!"))
    .catch(err => console.error("❌ MongoDB connection error:", err));
}

// Database Schema
const BookSchema = new mongoose.Schema({
  title: String,
  description: String,
  filename: String,
  pages: Number,
  chunkCount: Number,
  createdAt: { type: Date, default: Date.now },
  chunks: [String] // Array of raw text paragraph strings
});

const Book = mongoose.model("Book", BookSchema);

// ─── 1. Middlewares & Uploads ───────────────────────────────────────────────
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use(express.static("public"));
app.use(express.json());
app.use("/chat", limiter);
app.use("/admin", limiter);

// Serverless environments (like Vercel) only allow writing to /tmp
const UPLOAD_DIR = process.env.VERCEL ? "/tmp" : "uploads/";
if (!fs.existsSync(UPLOAD_DIR)) {
    try { fs.mkdirSync(UPLOAD_DIR); } catch (e) {} // Ignore if Vercel prevents mkdir
}

const storage = multer.diskStorage({
  destination: process.env.VERCEL ? "/tmp" : "uploads/",
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

// Multi-User Sessions (In-Memory array kept small for fast history)
const sessions = new Map();

// Simplified RAG Keyword Search algorithm
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

// Public: Get Library Catalogue from MongoDB
app.get("/books", async (req, res) => {
  try {
    // Specifically exclude 'chunks' to save bandwidth!
    const books = await Book.find({}, { chunks: 0 }).sort({ createdAt: -1 });
    
    // Map _id to id for the frontend
    const formatted = books.map(b => ({
      id: b._id,
      title: b.title,
      description: b.description,
      filename: b.filename,
      pages: b.pages,
      chunkCount: b.chunkCount
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch library from database." });
  }
});

// Admin: Upload Book Pipeline -> Store to MongoDB
app.post("/admin/upload", upload.single("pdf"), async (req, res) => {
  const { title, description } = req.body;
  
  if (!title || !description || !req.file) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "Missing title, description, or file." });
  }

  try {
    let filePath = path.join(process.cwd(), req.file.path);
    if (process.env.VERCEL) {
        // In Vercel, req.file.path usually points directly to /tmp/filename
        filePath = req.file.path; 
    }

    // Parse PDF
    const parser = new PDFParse({ data: fs.readFileSync(filePath) });
    const result = await parser.getText();
    await parser.destroy();
    
    // 🔥 Cleanup: Delete the actual PDF to save server disk space!
    fs.unlinkSync(filePath);

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

    // Save Metadata & Chunks to MongoDB ✨
    const newBook = new Book({
      title: title.trim(),
      description: description.trim(),
      filename: req.file.originalname,
      pages: result.total,
      chunkCount: docChunks.length,
      chunks: docChunks
    });

    await newBook.save();

    res.json({ 
        success: true, 
        book: { id: newBook._id, title: newBook.title, pages: newBook.pages } 
    });
  } catch (err) {
    console.error("Admin upload error:", err);
    res.status(500).json({ error: "Failed to parse and store PDF to database." });
  }
});

// Admin: Update Book Metadata
app.put("/admin/books/:id", async (req, res) => {
  const { title, description } = req.body;
  if (!title || !description) return res.status(400).json({ error: "Missing title or description." });

  try {
    const updatedBook = await Book.findByIdAndUpdate(req.params.id, { 
      title: title.trim(), 
      description: description.trim() 
    }, { new: true, select: "-chunks" });
    
    if (!updatedBook) return res.status(404).json({ error: "Book not found." });
    res.json({ success: true, book: updatedBook });
  } catch (err) {
    res.status(500).json({ error: "Failed to update book." });
  }
});

// Admin: Delete Book
app.delete("/admin/books/:id", async (req, res) => {
  try {
    const deletedBook = await Book.findByIdAndDelete(req.params.id);
    if (!deletedBook) return res.status(404).json({ error: "Book not found." });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete book." });
  }
});

// Public: Streaming Chat connecting to the DB
app.get("/chat", async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  const { message, bookId } = req.query;
  
  if (!sessionId || !message || !bookId) return res.end();

  try {
    // Load Specific Book Chunks directly from MongoDB
    const book = await Book.findById(bookId, { chunks: 1 });
    if (!book || !book.chunks) {
      res.write("data: " + JSON.stringify({ error: `Book ID ${bookId} not found in database.` }) + "\n\n");
      return res.end();
    }

    // Ensure session exists
    if (!sessions.has(sessionId)) sessions.set(sessionId, { history: [] });
    const session = sessions.get(sessionId);

    // Apply RAG Context to prevent Ollama from crashing
    const bestChunks = getTopChunks(message, book.chunks, 7);
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

    // Short-term conversational memory
    session.history.push({ role: "user", content: message });
    session.history.push({ role: "assistant", content: fullReply });
    if (session.history.length > 6) {
      session.history = session.history.slice(session.history.length - 6);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    console.error("Chat error:", error);
    res.write("data: " + JSON.stringify({ error: "API connection or Database lookup failed" }) + "\n\n");
    res.end();
  }
});

// IMPORTANT: Export ‘app’ for Vercel serverless environment
export default app;

// Start server locally if not on Vercel
if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`\n🚀 Dev Server is running at http://localhost:${port}`);
    console.log(`🌍 IMPORTANT: You must provide a valid MONGO_URI in .env!`);
  });
}