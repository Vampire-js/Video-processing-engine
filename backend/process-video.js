import { execFile, spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";

const exec = promisify(execFile);
export const enginePath = fileURLToPath(
  new URL("../processing-engine/build/video-engine", import.meta.url),
);
const defaultThreads = 5;

export function parseFilters(text) {
  const filters = JSON.parse(text);
  if (!Array.isArray(filters) || filters.length > 16) {
    throw new Error("Filters must be an array with at most 16 steps.");
  }
  return filters.map((filter) => {
    if (filter?.type === "grayscale" || filter?.type === "invert") {
      return filter.type;
    }
    if (filter?.type === "brightness" && Number.isInteger(filter.value)
        && filter.value >= -100 && filter.value <= 100) {
      return `brightness:${filter.value}`;
    }
    throw new Error("Use grayscale, invert, or brightness (-100 to 100).");
  }).join(",") || "none";
}

function start(command, args, children, signal) {
  const child = spawn(command, args, { signal, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, terminationSignal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${code ?? terminationSignal}): ${stderr.trim()}`));
    });
  });
  return { child, done };
}

export async function processVideo(input, output, filters, {
  threads = Number(process.env.THREADS ?? defaultThreads),
  signal,
} = {}) {
  if (!Number.isInteger(threads) || threads < 1 || threads > 32) {
    throw new Error("THREADS must be an integer between 1 and 32.");
  }
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,avg_frame_rate", "-of", "json", input,
  ], { signal });
  const stream = JSON.parse(stdout).streams?.[0];
  const [numerator, denominator] = (stream?.avg_frame_rate ?? "").split("/").map(Number);
  const fps = numerator / denominator;
  if (!Number.isInteger(stream?.width) || !Number.isInteger(stream?.height)
      || stream.width < 1 || stream.height < 1 || stream.width > 8192 || stream.height > 8192
      || !Number.isFinite(fps) || fps <= 0 || fps > 240) {
    throw new Error("Upload a video up to 8192x8192 with a valid frame rate (up to 240 fps).");
  }

  const children = [];
  const common = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  const decoder = start("ffmpeg", [
    ...common, "-noautorotate", "-i", input, "-map", "0:v:0",
    "-vf", `fps=${stream.avg_frame_rate}`, "-threads", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], children, signal);
  const engine = start(enginePath, [
    String(stream.width), String(stream.height), String(threads), filters,
  ], children, signal);
  const encoder = start("ffmpeg", [
    ...common, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
    "-video_size", `${stream.width}x${stream.height}`,
    "-framerate", stream.avg_frame_rate, "-i", "pipe:0", "-i", input,
    "-map", "0:v:0", "-map", "1:a:0?", "-map_metadata", "-1",
    "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2,setsar=1",
    "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-threads", "1", "-c:a", "aac", "-movflags", "+faststart", output,
  ], children, signal);
  decoder.child.stdin.end();
  encoder.child.stdout.resume();
  const tasks = [
    decoder.done, engine.done, encoder.done,
    pipeline(decoder.child.stdout, engine.child.stdin),
    pipeline(engine.child.stdout, encoder.child.stdin),
  ];
  try {
    await Promise.all(tasks);
  } catch (error) {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.allSettled(tasks);
    throw error;
  }
}
