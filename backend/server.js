import express from "express";
import cors from "cors";
import multer from "multer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFilters, processVideo } from "./process-video.js";

export const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? "*" }));
app.get("/health", (_request, response) => response.json({ status: "ok" }));

app.post("/api/process", async (request, response) => {
  const directory = await mkdtemp(join(tmpdir(), "video-processing-"));
  const controller = new AbortController();
  const abort = () => {
    if (!response.writableEnded) controller.abort();
  };
  response.once("close", abort);
  try {
    const upload = multer({
      dest: directory,
      limits: { fileSize: 250 * 1024 * 1024, files: 1, fields: 1, fieldSize: 8192 },
    }).single("video");
    await new Promise((resolve, reject) => {
      upload(request, response, (error) => error ? reject(error) : resolve());
    });
    if (!request.file) {
      response.status(400).json({ error: "A video file is required." });
      return;
    }
    let filters;
    try {
      filters = parseFilters(request.body.filters ?? "[]");
    } catch (error) {
      response.status(400).json({ error: `Invalid filters: ${error.message}` });
      return;
    }
    const output = join(directory, "processed.mp4");
    await processVideo(request.file.path, output, filters, { signal: controller.signal });
    await new Promise((resolve, reject) => {
      response.download(output, "processed.mp4", (error) => error ? reject(error) : resolve());
    });
  } catch (error) {
    console.error(error);
    if (!response.headersSent && !response.destroyed) {
      const status = error instanceof multer.MulterError
        ? (error.code === "LIMIT_FILE_SIZE" ? 413 : 400) : 500;
      response.status(status).json({
        error: error instanceof multer.MulterError
          ? (status === 413 ? "Video must be 250 MB or smaller." : error.message)
          : "Video processing failed. Check the video and the backend logs.",
      });
    }
  } finally {
    response.off("close", abort);
    await rm(directory, { recursive: true, force: true });
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, "127.0.0.1", () => console.log(`Video API: http://localhost:${port}`));
}
