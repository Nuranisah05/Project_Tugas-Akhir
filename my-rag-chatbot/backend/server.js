// backend/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import Groq from "groq-sdk";
import { pipeline } from "@xenova/transformers";
import "dotenv/config";
import { fileURLToPath } from "url";

// =============================
// ESM __dirname
// =============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================
// APP INIT
// =============================
const app = express();
app.use(cors());
app.use(express.json());

// =============================
// SESSION STORAGE (PERSISTENT)
// =============================
const SESSIONS_FILE = path.join(__dirname, "sessions.json");

function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify([]));
  }
  return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
}

function saveSessions(data) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

let sessions = loadSessions();

function findSession(id) {
  return sessions.find((s) => s.id === id);
}

// =============================
// LOAD EMBEDDINGS (RAG)
// =============================
console.log("📁 Loading embeddings.json...");
const EMB_PATH = path.join(__dirname, "embeddings.json");
const DB_RAW = JSON.parse(fs.readFileSync(EMB_PATH, "utf-8"));

const CHUNKS = Object.values(DB_RAW).map((x) => {
  const emb = (x.embedding || []).map(Number);
  const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0)) || 1;
  const text = x.text || "";
  return {
    text,
    textLower: text.toLowerCase(),
    embedding: emb,
    norm,
  };
});

console.log(`✅ Loaded ${CHUNKS.length} chunks.`);

console.log("🔄 Loading MiniLM...");
const embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
console.log("✅ MiniLM ready!");

// =============================
// UTILS
// =============================
function generateTitleFromQuestion(question) {
  const clean = question.replace(/\n/g, " ").replace(/[^\w\s]/gi, "").trim();
  if (clean.length <= 40) return clean;
  return clean.slice(0, 40) + "...";
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function cosineWithNorm(a, b, normB) {
  const normA = Math.sqrt(a.reduce((s, v) => s + v * v, 0)) || 1;
  return dot(a, b) / (normA * (normB || 1));
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// ✅ lexical score: angka pendek tetap dihitung (untuk ayat (1), (2), dst)
function lexicalOverlapScore(qTokens, chunkLower) {
  let hit = 0;
  let denom = 0;

  for (const t of qTokens) {
    if (!t) continue;

    const isNumber = /^\d{1,2}$/.test(t);
    if (t.length < 3 && !isNumber) continue;

    denom++;

    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|\\s)${escaped}(\\s|$)`, "i");

    if (re.test(chunkLower)) hit++;
    else if (chunkLower.includes(t)) hit += 0.5;
  }

  return hit / Math.max(1, denom);
}

// =============================
// HARD GUARD (substring check)
// =============================
function normalizeForCheck(s) {
  return String(s || "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function answerIsFromContext(answer, context) {
  const a = normalizeForCheck(answer);
  const c = normalizeForCheck(context);
  if (!a) return false;
  return c.includes(a);
}

function clampAnswer(answer, maxChars = 2200) {
  const a = (answer || "").trim();
  if (a.length <= maxChars) return a;
  return a.slice(0, maxChars).trim();
}

// =============================
// LEGAL REF (Pasal/Ayat) DETECTOR
// =============================
function extractLegalRef(question) {
  const q = question.toLowerCase();
  const pasalMatch = q.match(/\bpasal\s+(\d+)\s*([a-z])?\b/i);
  const ayatMatch = q.match(/\bayat\s*\(?\s*(\d+)\s*\)?\b/i);
  if (!pasalMatch && !ayatMatch) return null;

  const pasalNum = pasalMatch ? pasalMatch[1] : null;
  const pasalLet = pasalMatch && pasalMatch[2] ? pasalMatch[2] : "";
  const pasal = pasalNum ? `${pasalNum}${pasalLet}` : null;
  const ayat = ayatMatch ? ayatMatch[1] : null;

  return { pasal, ayat };
}

function chunkMatchesLegalRef(chunkLower, ref) {
  if (!ref) return false;
  let ok = true;

  if (ref.pasal) {
    const pasalA = `pasal ${ref.pasal}`;
    const pasalB = `pasal ${ref.pasal.replace(/(\d+)([a-z])$/i, "$1 $2")}`;
    ok = ok && (chunkLower.includes(pasalA) || chunkLower.includes(pasalB));
  }

  if (ref.ayat) {
    const ayatA = `ayat (${ref.ayat})`;
    const ayatB = `ayat ${ref.ayat}`;
    ok = ok && (chunkLower.includes(ayatA) || chunkLower.includes(ayatB));
  }

  return ok;
}

// =============================
// SNIPPET + DEFINISI EXTRACTOR
// =============================
function isNoiseLine(line) {
  const l = (line || "").trim();
  if (!l) return true;

  if (/www\./i.test(l) || /http/i.test(l) || /\.ac\.id/i.test(l)) return true;
  if (/program studi/i.test(l)) return true;
  if (/^\d{1,3}-\d{1,3}\b/.test(l)) return true;
  if (/^[-_=]{3,}$/.test(l)) return true;

  return false;
}

function extractBestSnippet(question, text, maxLines = 6) {
  const qTokens = tokenize(question);
  const rawLines = String(text || "").replace(/\r/g, "").split("\n");
  const lines = rawLines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return String(text || "").trim();

  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isNoiseLine(line)) continue;

    const score = lexicalOverlapScore(qTokens, line.toLowerCase());
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestScore < 0) return lines.slice(0, maxLines).join("\n");

  const start = Math.max(0, bestIdx - 2);
  const end = Math.min(lines.length, bestIdx + maxLines);

  const snippetLines = [];
  for (let i = start; i < end; i++) {
    if (isNoiseLine(lines[i])) continue;
    snippetLines.push(lines[i]);
    if (snippetLines.length >= maxLines) break;
  }

  return (snippetLines.length ? snippetLines : [lines[bestIdx]]).join("\n").trim();
}

function isDefinitionQuestion(question) {
  const q = question.toLowerCase();
  return (
    q.includes("apa yang dimaksud") ||
    q.includes("pengertian") ||
    q.includes("definisi") ||
    q.includes("yang dimaksud")
  );
}

function extractAcronyms(question) {
  const raw = String(question || "");
  const matches = raw.match(/[A-Z]{4,}(?:\s+[A-Z]{2,})*/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.trim()).filter(Boolean))];
}

function extractDefinitionSnippet(question, text, maxLines = 8) {
  if (!isDefinitionQuestion(question)) return null;

  const acronyms = extractAcronyms(question);
  const t = String(text || "").replace(/\r/g, "");
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  let idx = -1;

  for (const ac of acronyms) {
    const found = lines.findIndex((l) => l.toLowerCase().includes(ac.toLowerCase()));
    if (found !== -1) {
      idx = found;
      break;
    }
  }

  if (idx === -1) idx = lines.findIndex((l) => /disingkat\s+menjadi/i.test(l));
  if (idx === -1) idx = lines.findIndex((l) => /\bdisingkat\b/i.test(l));
  if (idx === -1) return null;

  const start = Math.max(0, idx - 3);
  const end = Math.min(lines.length, idx + 2);

  const picked = [];
  for (let i = start; i < end; i++) {
    if (isNoiseLine(lines[i])) continue;
    picked.push(lines[i]);
    if (picked.length >= maxLines) break;
  }

  return picked.length ? picked.join("\n").trim() : null;
}

// UI fix kecil (display only)
function dropLeadingFragment(text) {
  if (!text) return text;
  const t = String(text).trim();
  if (!t) return t;

  const firstWord = t.split(/\s+/)[0] || "";
  const looksFragment = /^[a-z]/.test(firstWord) && firstWord.length <= 6;
  if (!looksFragment) return t;

  return t.replace(/^\S+\s+/, "");
}

function formatForUI(text) {
  if (!text) return text;

  let t = String(text).replace(/\r/g, "").trim();

  // Pastikan bullet "●" jadi list markdown
  // dan bikin baris baru sebelum list supaya rapi
  t = t.replace(/\s*●\s*/g, "\n- ");

  // Kalau ada kalimat lalu langsung list, kasih jarak 1 baris kosong
  // contoh: ".... 1945.\n- Penjabaran..." -> jadi ".... 1945.\n\n- Penjabaran..."
  t = t.replace(/(\S)\n-\s/g, "$1\n\n- ");

  // Rapihin newline berlebihan
  t = t.replace(/\n{3,}/g, "\n\n");

  // Rapihin spasi berlebih (jangan ganggu newline)
  t = t
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n");

  return t.trim();
}


// =============================
// CONFIG
// =============================
const RAG_THRESHOLD = 0.45;
const STRICT_CONTEXT_ONLY = true;

// ✅ ganti ke model lebih hemat kalau mau:
// const GROQ_MODEL = "llama-3.1-8b-instant";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// =============================
// API: LIST SESSIONS
// =============================
app.get("/sessions", (req, res) => {
  const list = sessions
    .map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      lastMessage:
        s.messages.length > 0 ? s.messages[s.messages.length - 1].text : "",
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  res.json(list);
});

// =============================
// API: CREATE SESSION
// =============================
app.post("/sessions", (req, res) => {
  const now = Date.now();

  const welcomeMessage = {
    sender: "ai",
    text:
      "Halo 👋\n\nAku adalah **PancaAI**, asisten AI untuk mata kuliah **PPKN**. Silakan ajukan pertanyaan pertamamu 😊",
    at: now,
  };

  const newSession = {
    id: "sess_" + now,
    title: `Chat ${sessions.length + 1}`,
    createdAt: now,
    updatedAt: now,
    messages: [welcomeMessage],
  };

  sessions.push(newSession);
  saveSessions(sessions);

  res.json(newSession);
});

// =============================
// API: GET SESSION MESSAGES
// =============================
app.get("/sessions/:id", (req, res) => {
  const session = findSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session.messages);
});

// =============================
// API: DELETE SESSION
// =============================
app.delete("/sessions/:id", (req, res) => {
  const { id } = req.params;
  const index = sessions.findIndex((s) => s.id === id);
  if (index === -1) {
    return res.status(404).json({ error: "Session not found" });
  }

  sessions.splice(index, 1);
  saveSessions(sessions);

  res.json({ success: true });
});

// =============================
// API: ASK (RAG + LLM + HARD GUARD + RATE LIMIT FALLBACK)
// =============================
app.post("/sessions/:id/ask", async (req, res) => {
  try {
    const { id } = req.params;
    const { question } = req.body;

    if (!question) return res.status(400).json({ error: "Question is required." });

    const session = findSession(id);
    if (!session) return res.status(404).json({ error: "Session not found." });

    // =============================
    // EMBED QUERY
    // =============================
    const qTokens = tokenize(question);
    const qEmb = Array.from(
      (await embedder(question, { pooling: "mean", normalize: true })).data
    );

    // =============================
    // HYBRID SEARCH (+ legal ref filter)
    // =============================
    const legalRef = extractLegalRef(question);

    let scored = CHUNKS.map((c) => {
      const semantic = cosineWithNorm(qEmb, c.embedding, c.norm);
      const lexical = lexicalOverlapScore(qTokens, c.textLower);

      let boost = 0;
      if (legalRef && chunkMatchesLegalRef(c.textLower, legalRef)) boost = 0.25;

      const score = 0.80 * semantic + 0.20 * lexical + boost;
      return { chunk: c, semantic, lexical, boost, score };
    });

    if (legalRef) {
      const filtered = scored.filter((x) => chunkMatchesLegalRef(x.chunk.textLower, legalRef));
      if (filtered.length > 0) scored = filtered;
    }

    // ✅ ambil top-3 saja biar hemat token
    const ranked = scored.sort((a, b) => b.score - a.score).slice(0, 3);
    const top = ranked[0] || null;

    const isShortQ = qTokens.length <= 4;
    const threshold = isShortQ ? 0.48 : RAG_THRESHOLD;

    console.log("🔎 RAG top:", {
      question,
      threshold,
      topScore: top ? Number(top.score.toFixed(4)) : 0,
      semantic: top ? Number(top.semantic.toFixed(4)) : 0,
      lexical: top ? Number(top.lexical.toFixed(4)) : 0,
    });

    if (!top || top.score < threshold) {
      return res.json({
        answer:
          "Maaf, pertanyaan tersebut tidak ditemukan atau tidak cukup relevan dalam materi PPKN yang tersedia.",
        rawAnswer:
          "Maaf, pertanyaan tersebut tidak ditemukan atau tidak cukup relevan dalam materi PPKN yang tersedia.",
        contextUsed: "",
        usedLLM: false,
      });
    }

    // =============================
    // CONTEXT: prioritas definisi, jika tidak pakai snippet biasa
    // =============================
    const contextSnippets = ranked
      .map((r) => {
        const def = extractDefinitionSnippet(question, r.chunk.text, 8);
        if (def) return def;
        return extractBestSnippet(question, r.chunk.text, isDefinitionQuestion(question) ? 8 : 6);
      })
      .join("\n\n---\n\n");

    // =============================
    // AUTO TITLE (PERTANYAAN PERTAMA)
    // =============================
    if (session.messages.length === 1) {
      session.title = generateTitleFromQuestion(question);
    }

    // =============================
    // MEMORY: batasi 3 Q/A terakhir biar hemat token
    // =============================
    const historyText = session.messages
      .slice(-6)
      .map((m) => `${m.sender === "user" ? "User" : "AI"}: ${m.text}`)
      .join("\n");

    // =============================
    // LLM PROMPT (KUTIPAN VERBATIM)
    // =============================
    const baseRules = `
ATURAN KETAT (WAJIB):
1) Jawaban HARUS berupa KUTIPAN VERBATIM dari KONTEKS (copy-paste persis, jangan ubah 1 karakter pun).
2) DILARANG menambah kata, menjelaskan, menyimpulkan, atau memparafrase.
3) DILARANG menulis pembuka/penutup seperti "Berdasarkan konteks...".
4) Jika tidak ada kalimat yang menjawab, balas tepat: TIDAK DITEMUKAN
5) Jawaban dalam paragraf yang tetap harus verbatim.
6) Jangan pilih header/footer (email, URL, nomor slide, Program Studi, STT).
7) Jangan output kepotong; lanjutkan sampai kalimat/kutipan selesai.
`.trim();

    const prompt1 = `
Kamu adalah asisten PPKN berbasis RAG.

${baseRules}

MEMORY:
${historyText}

KONTEKS:
${contextSnippets}

PERTANYAAN:
${question}

Jawaban:
`.trim();

    const prompt2 = `
${baseRules}

PENTING:
- Output kamu HARUS 100% substring dari KONTEKS.
- Jika ragu: TIDAK DITEMUKAN

KONTEKS:
${contextSnippets}

PERTANYAAN:
${question}

Jawaban:
`.trim();

    // =============================
    // CALL LLM (dengan handle rate limit)
    // =============================
    let rawAnswer = "TIDAK DITEMUKAN";
    let usedLLM = true;

    try {
      const completion1 = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: "Kamu hanya boleh menyalin kutipan dari konteks." },
          { role: "user", content: prompt1 },
        ],
        temperature: 0,
        max_tokens: 600, // ✅ hemat token
      });

      let candidate1 =
        completion1.choices?.[0]?.message?.content?.trim() || "TIDAK DITEMUKAN";
      candidate1 = clampAnswer(candidate1);

      const isValid1 =
        candidate1 === "TIDAK DITEMUKAN"
          ? false
          : answerIsFromContext(candidate1, contextSnippets);

      rawAnswer = candidate1;

      if (!isValid1 && STRICT_CONTEXT_ONLY) {
        const completion2 = await groq.chat.completions.create({
          model: GROQ_MODEL,
          messages: [
            { role: "system", content: "Output wajib kutipan persis dari konteks atau TIDAK DITEMUKAN." },
            { role: "user", content: prompt2 },
          ],
          temperature: 0,
          max_tokens: 400, // ✅ retry lebih kecil
        });

        let candidate2 =
          completion2.choices?.[0]?.message?.content?.trim() || "TIDAK DITEMUKAN";
        candidate2 = clampAnswer(candidate2);

        const isValid2 =
          candidate2 === "TIDAK DITEMUKAN"
            ? false
            : answerIsFromContext(candidate2, contextSnippets);

        if (isValid2) {
          rawAnswer = candidate2;
        } else {
          usedLLM = false;
          rawAnswer =
            extractDefinitionSnippet(question, top.chunk.text, 8) ||
            extractBestSnippet(question, top.chunk.text, isDefinitionQuestion(question) ? 8 : 6);
        }
      } else {
        if (!isValid1) {
          usedLLM = false;
          rawAnswer =
            extractDefinitionSnippet(question, top.chunk.text, 8) ||
            extractBestSnippet(question, top.chunk.text, isDefinitionQuestion(question) ? 8 : 6);
        }
      }
    } catch (err) {
      // ✅ 429 / error Groq -> fallback extractive
      console.error("❌ Groq error:", err?.message || err);
      usedLLM = false;
      rawAnswer =
        extractDefinitionSnippet(question, top.chunk.text, 8) ||
        extractBestSnippet(question, top.chunk.text, isDefinitionQuestion(question) ? 8 : 6);
    }

    // UI clean (opsional)
    const answer = STRICT_CONTEXT_ONLY ? rawAnswer : formatForUI(rawAnswer);


    // =============================
    // SAVE HISTORY
    // =============================
    const now = Date.now();
    session.messages.push({ sender: "user", text: question, at: now });
    session.messages.push({
      sender: "ai",
      text: answer,       // ✅ versi rapi untuk UI
      rawText: rawAnswer, // ✅ versi asli untuk ROUGE
      at: now,
      usedLLM,
    });    

    session.updatedAt = now;
    saveSessions(sessions);

    return res.json({ answer, rawAnswer, contextUsed: contextSnippets, usedLLM });
  } catch (err) {
    console.error("❌ ERROR /ask:", err);
    res.status(500).json({ error: err.message });
  }
});

// =============================
// RUN SERVER
// =============================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Multi-session RAG server running at http://localhost:${PORT}`);
});
