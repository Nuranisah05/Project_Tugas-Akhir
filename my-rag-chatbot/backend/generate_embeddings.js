// backend/generate_embeddings.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pipeline } from "@xenova/transformers";

// ESM helper untuk __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Folder tempat potongan dokumen (.txt)
const DOCS_DIR = path.join(__dirname, "docsTxt");

console.log("📂 Membaca folder chunks:", DOCS_DIR);

// Baca semua file .txt di docsTxt
const files = fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith(".txt"));

if (files.length === 0) {
  console.error("❌ Tidak ada file .txt di folder docsTxt.");
  process.exit(1);
}

console.log(`✅ Ditemukan ${files.length} file chunk.`);

// Load model MiniLM
console.log("🔄 Loading MiniLM (Xenova/all-MiniLM-L6-v2)...");
const embedder = await pipeline(
  "feature-extraction",
  "Xenova/all-MiniLM-L6-v2"
);
console.log("✅ MiniLM siap!");

// Object DB untuk embeddings
const DB = {};

let index = 0;

for (const file of files) {
  index++;
  const fullPath = path.join(DOCS_DIR, file);
  const text = fs.readFileSync(fullPath, "utf-8").trim();

  if (!text) {
    console.log(`⚠️  [${index}/${files.length}] ${file} kosong, dilewati.`);
    continue;
  }

  console.log(`🔎 Embedding [${index}/${files.length}]: ${file}`);

  const emb = await embedder(text, { pooling: "mean", normalize: true });
  const vector = Array.from(emb.data); // Float32Array -> array biasa

  // simpan dengan key = nama file
  DB[file] = {
    text,
    embedding: vector,
  };
}

// Tulis ke embeddings.json (overwrite)
const outPath = path.join(__dirname, "embeddings.json");
fs.writeFileSync(outPath, JSON.stringify(DB, null, 2), "utf-8");

console.log("✅ Selesai! embeddings.json berhasil dibuat di:");
console.log("   ", outPath);
