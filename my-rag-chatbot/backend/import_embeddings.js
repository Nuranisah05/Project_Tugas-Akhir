import fs from "fs";
import path from "path";
import { pipeline } from "@xenova/transformers";

// Load embedding model
console.log("🔄 Loading MiniLM model...");
const embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
console.log("✅ MiniLM loaded!");

// Folder dokumen
const DOCS_DIR = "./docsTxt";

// Output file
const OUTPUT = "./embeddings.json";

async function embedText(text) {
  const output = await embedder(text, {
    pooling: "mean",
    normalize: true
  });
  return Array.from(output.data);
}

async function run() {
  console.log("📚 Starting embedding generator...");

  const files = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith(".txt") || f.endsWith(".md"));
  const db = {};

  for (const filename of files) {
    const fullPath = path.join(DOCS_DIR, filename);
    const raw = fs.readFileSync(fullPath, "utf-8");

    console.log(`✂️ Chunking: ${filename}`);

    // Simple chunker
    const chunks = raw.match(/[\s\S]{1,800}/g) || [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];

      console.log(`🔍 Embedding chunk ${i + 1}/${chunks.length}`);

      const embedding = await embedText(chunkText);

      db[`${filename}_chunk_${i}`] = {
        text: chunkText,
        embedding
      };
    }
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(db, null, 2));
  console.log(`\n✅ Embeddings saved to ${OUTPUT}`);
}

run();
