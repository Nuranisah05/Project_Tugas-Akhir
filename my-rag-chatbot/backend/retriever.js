// backend/retriever.js
import lancedb from "@lancedb/lancedb";
import { pipeline } from "@xenova/transformers";

console.log("⏳ Loading local embedding model...");
const embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");

const db = await lancedb.connect("./lancedb");
const table = await db.openTable("docs");

export async function retrieve(query) {
    // Buat embedding lokal untuk pertanyaan
    const output = await embedder(query, { pooling: "mean" });
    const queryVector = Array.from(output.data);

    // Cari chunk terdekat
    const results = await table.search(queryVector).limit(3).toArray();

    return results.map(r => r.text);
}
