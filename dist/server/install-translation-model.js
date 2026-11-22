#!/usr/bin/env node

// scripts/install-translation-model.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path2 from "node:path";

// src/server/translation-files.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
var modelRevision = "046f55aec303cdee3e0318604406d4df20f1e8ea";
var modelFiles = [
  { name: "config.json", bytes: 1503, digest: "4727d1229a04f95bf6f39abf949d8080615433d99d6ebd85f81c09edd247d5fa" },
  { name: "generation_config.json", bytes: 293, digest: "b743baabb7da4c1a2f19fe558bd6b4c0c7c3b0762fcb5ca7a48fe5a2c2219803" },
  { name: "special_tokens_map.json", bytes: 74, digest: "5e4d1f5e759d74cb1c2fe1d165cfc62b5237aa904de759380cd6f43042eec723" },
  { name: "tokenizer.json", bytes: 6380952, digest: "d0c7da27056e8f42adce9e76d8e792e5daa64e15f5acd2e7aabf0121877dd4c1" },
  { name: "tokenizer_config.json", bytes: 282, digest: "a914596e6bff113a8428d4793b586da87cd0b95697a0e72aba90cc1d95858481" },
  { name: "onnx/encoder_model_quantized.onnx", bytes: 52899742, digest: "d3b7912bf6a9bd27e4c074c2df91d4ff3d5b4bc5f7f6c8d7cc9c805c98fbafee" },
  { name: "onnx/decoder_model_merged_quantized.onnx", bytes: 60212804, digest: "023be4f841f4c47cd65fffcbaa81c0d99d7f7e0138f7ba0e03fa220a4e688aff" }
];
function localModelDirectory() {
  return process.env.PAPER_READER_MT_MODEL_DIR ? path.resolve(process.env.PAPER_READER_MT_MODEL_DIR) : fileURLToPath(new URL("../../.runtime/mt-weights/opus-mt-en-zh", import.meta.url));
}

// scripts/install-translation-model.ts
var dir = localModelDirectory();
var source = "https://huggingface.co/Xenova/opus-mt-en-zh/resolve/" + modelRevision + "/";
var digest = (content) => createHash("sha256").update(content).digest("hex");
for (const file of modelFiles) {
  const destination = path2.join(dir, file.name);
  try {
    if (digest(await readFile(destination)) === file.digest) continue;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const response = await fetch(source + file.name, { signal: AbortSignal.timeout(3e5) });
  if (!response.ok) throw new Error("Could not download " + file.name + " (HTTP " + response.status + ").");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== file.bytes || digest(bytes) !== file.digest) throw new Error("Integrity check failed for " + file.name + ".");
  await mkdir(path2.dirname(destination), { recursive: true });
  const temporary = destination + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
console.log("Verified the local OPUS-MT English-to-Chinese model at " + dir);
