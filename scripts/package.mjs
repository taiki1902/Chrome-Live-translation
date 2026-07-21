import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import archiver from "archiver";

const root = process.cwd();
const dist = path.join(root, "dist");
const extensionDir = path.join(dist, "extension");
const files = ["manifest.json", "src", "icons", "PRIVACY.md"];

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(extensionDir, { recursive: true });
for (const entry of files) {
  await fs.cp(path.join(root, entry), path.join(extensionDir, entry), {
    recursive: true,
  });
}

const zipPath = path.join(dist, "helium-live-translator-v0.1.0.zip");
await new Promise((resolve, reject) => {
  const output = createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });
  output.on("close", resolve);
  output.on("error", reject);
  archive.on("error", reject);
  archive.pipe(output);
  archive.directory(extensionDir, false);
  archive.finalize();
});
console.log(`Built ${zipPath}`);
