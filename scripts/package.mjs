import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";
import webpack from "webpack";

const root = process.cwd();
const dist = path.join(root, "dist");
const extensionDir = path.join(dist, "extension");
const offscreenOutputDir = path.join(extensionDir, "src", "offscreen");
const version = JSON.parse(
  await fs.readFile(path.join(root, "manifest.json"), "utf8"),
).version;

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(extensionDir, { recursive: true });

for (const entry of ["manifest.json", "src", "icons", "PRIVACY.md"]) {
  await fs.cp(path.join(root, entry), path.join(extensionDir, entry), {
    recursive: true,
  });
}

await fs.rm(path.join(extensionDir, "src", "offscreen", "offscreen.js"), {
  force: true,
});
await fs.rm(path.join(extensionDir, "src", "shared", "openai.js"), {
  force: true,
});
await fs.mkdir(offscreenOutputDir, { recursive: true });

await runWebpack({
  mode: "production",
  target: ["web", "es2022"],
  entry: path.join(root, "src", "offscreen", "offscreen.js"),
  devtool: false,
  experiments: {
    outputModule: true,
  },
  resolve: {
    conditionNames: ["browser", "import", "module", "default"],
  },
  output: {
    path: offscreenOutputDir,
    filename: "offscreen.js",
    module: true,
    chunkFormat: "module",
    chunkLoading: false,
    clean: false,
  },
  optimization: {
    minimize: true,
  },
});

const onnxDist = await findOnnxRuntimeDist(path.join(root, "node_modules"));
const onnxOutput = path.join(extensionDir, "vendor", "onnx");
await fs.mkdir(onnxOutput, { recursive: true });

const runtimeFiles = (await fs.readdir(onnxDist)).filter((file) =>
  /\.(?:wasm|mjs)$/.test(file),
);
if (runtimeFiles.length === 0) {
  throw new Error(`ONNX Runtime browser assets were not found in ${onnxDist}`);
}
for (const file of runtimeFiles) {
  await fs.copyFile(path.join(onnxDist, file), path.join(onnxOutput, file));
}

const zipPath = path.join(dist, `helium-live-translator-v${version}.zip`);
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

function runWebpack(config) {
  return new Promise((resolve, reject) => {
    webpack(config, (error, stats) => {
      if (error) {
        reject(error);
        return;
      }

      if (stats?.hasErrors()) {
        reject(new Error(stats.toString({ all: false, errors: true })));
        return;
      }

      console.log(
        stats?.toString({
          assets: true,
          colors: false,
          modules: false,
          timings: true,
          warnings: true,
        }),
      );
      resolve();
    });
  });
}

async function findOnnxRuntimeDist(nodeModulesRoot) {
  const candidates = [
    path.join(nodeModulesRoot, "onnxruntime-web", "dist"),
    path.join(
      nodeModulesRoot,
      "@huggingface",
      "transformers",
      "node_modules",
      "onnxruntime-web",
      "dist",
    ),
  ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // Try the next package layout.
    }
  }

  throw new Error(
    "onnxruntime-web/dist could not be located after installation.",
  );
}
