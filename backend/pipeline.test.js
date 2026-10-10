import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "./server.js";
import { enginePath, parseFilters, processVideo } from "./process-video.js";

let directory;
let input;
let server;
let url;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "video-test-"));
  input = join(directory, "input.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=8:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", input,
  ]);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  url = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  if (directory) await rm(directory, { recursive: true, force: true });
});

function runEngine(bytes, threads, flow, width = 64, height = 48) {
  return spawnSync(enginePath, [String(width), String(height), String(threads), flow], {
    input: bytes, maxBuffer: 16 * 1024 * 1024, timeout: 10000,
  });
}

function reference(bytes, flow) {
  const result = Buffer.from(bytes);
  for (const step of flow) {
    if (step.type === "grayscale") {
      for (let i = 0; i < result.length; i += 3) {
        const gray = (77 * result[i] + 150 * result[i + 1] + 29 * result[i + 2]) >> 8;
        result[i] = result[i + 1] = result[i + 2] = gray;
      }
    } else {
      for (let i = 0; i < result.length; i++) {
        result[i] = step.type === "invert" ? 255 - result[i]
          : Math.max(0, Math.min(255, result[i] + Math.trunc(step.value * 255 / 100)));
      }
    }
  }
  return result;
}

test("filter validation rejects unknown and out-of-range steps", () => {
  assert.equal(parseFilters("[]"), "none");
  assert.equal(parseFilters('[{"type":"brightness","value":-20},{"type":"invert"}]'), "brightness:-20,invert");
  for (const invalid of ["null", "{}", "[null]", "[1]", "broken",
    '[{"type":"blur"}]', '[{"type":"brightness","value":101}]',
    '[{"type":"brightness","value":1.5}]',
    JSON.stringify(Array.from({ length: 17 }, () => ({ type: "invert" })))]) {
    assert.throws(() => parseFilters(invalid));
  }
});

test("all filters match scalar reference and preserve frame order with 1, 4, and 8 workers", () => {
  const bytes = Buffer.alloc(64 * 48 * 3 * 80);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + Math.floor(i / 9216) * 13) % 256;
  const flows = [
    [], [{ type: "grayscale" }], [{ type: "invert" }],
    [{ type: "brightness", value: 100 }], [{ type: "brightness", value: -100 }],
    [{ type: "brightness", value: -17 }, { type: "invert" }, { type: "grayscale" }],
    [{ type: "grayscale" }, { type: "brightness", value: 23 }, { type: "invert" }],
  ];
  for (const flow of flows) {
    const expected = reference(bytes, flow);
    for (const threads of [1, 4, 8]) {
      const result = runEngine(bytes, threads, parseFilters(JSON.stringify(flow)));
      assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
      assert.deepEqual(result.stdout, expected);
    }
  }
  assert.notDeepEqual(
    reference(bytes, [{ type: "brightness", value: 20 }, { type: "invert" }]),
    reference(bytes, [{ type: "invert" }, { type: "brightness", value: 20 }]),
  );
});

test("engine reports empty/truncated frames and invalid arguments without hanging", () => {
  for (const [bytes, threads, flow] of [
    [Buffer.alloc(0), 4, "none"], [Buffer.alloc(10), 4, "none"],
    [Buffer.alloc(9216 + 1), 4, "none"], [Buffer.alloc(9216), 0, "none"],
    [Buffer.alloc(9216), 4, "blur"], [Buffer.alloc(9216), 4, "invert,"],
  ]) {
    const result = runEngine(bytes, threads, flow);
    assert.equal(result.status, 1, result.error?.message);
    assert.ok(result.stderr.length > 0);
  }
});

function probe(path) {
  return JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-count_frames", "-show_streams", "-of", "json", path,
  ]));
}

function decode(path) {
  return execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:v:0",
    "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ]);
}

test("real video has identical ordered output with one/multiple workers and retains audio", async () => {
  const single = join(directory, "single.mp4");
  const multi = join(directory, "multi.mp4");
  const flow = "brightness:20,grayscale,invert";
  await processVideo(input, single, flow, { threads: 1 });
  await processVideo(input, multi, flow, { threads: 4 });
  assert.deepEqual(decode(single), decode(multi));
  const metadata = probe(multi);
  const video = metadata.streams.find((stream) => stream.codec_type === "video");
  const audio = metadata.streams.find((stream) => stream.codec_type === "audio");
  assert.equal(video.width, 64);
  assert.equal(video.height, 48);
  assert.equal(video.nb_read_frames, "8");
  assert.equal(video.codec_name, "h264");
  assert.equal(audio.codec_name, "aac");
  const pixels = decode(multi);
  for (let i = 0; i < pixels.length; i += 3) {
    assert.ok(Math.abs(pixels[i] - pixels[i + 1]) <= 2);
    assert.ok(Math.abs(pixels[i] - pixels[i + 2]) <= 2);
  }
  assert.notDeepEqual(pixels, decode(input));
});

test("silent odd-size video is padded and can be re-encoded with no filters", async () => {
  const oddInput = join(directory, "odd.mkv");
  const output = join(directory, "odd.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
    "-i", "testsrc=size=63x47:rate=5:duration=1", "-c:v", "ffv1", "-threads", "1", oddInput,
  ]);
  await processVideo(oddInput, output, "none");
  const metadata = probe(output);
  assert.equal(metadata.streams.length, 1);
  assert.equal(metadata.streams[0].width, 64);
  assert.equal(metadata.streams[0].height, 48);
  assert.equal(metadata.streams[0].nb_read_frames, "5");
});

test("API health, multipart processing, and concurrent uploads work", async () => {
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), { status: "ok" });
  const bytes = await readFile(input);
  await Promise.all(["grayscale", "invert"].map(async (type) => {
    const data = new FormData();
    data.append("video", new Blob([bytes], { type: "video/mp4" }), "clip.mp4");
    data.append("filters", JSON.stringify([{ type }]));
    const response = await fetch(`${url}/api/process`, { method: "POST", body: data });
    assert.equal(response.status, 200, response.statusText);
    assert.match(response.headers.get("content-type"), /video\/mp4/);
    assert.match(response.headers.get("content-disposition"), /processed\.mp4/);
    const output = join(directory, `api-${type}.mp4`);
    await writeFile(output, Buffer.from(await response.arrayBuffer()));
    assert.equal(probe(output).streams[0].nb_read_frames, "8");
  }));
});

test("API permits cross-origin requests and preflight", async () => {
  const origin = "http://127.0.0.1:3000";
  const expectedOrigin = process.env.FRONTEND_ORIGIN ?? "*";
  const response = await fetch(`${url}/health`, { headers: { Origin: origin } });
  assert.equal(response.headers.get("access-control-allow-origin"), expectedOrigin);
  const preflight = await fetch(`${url}/api/process`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), expectedOrigin);
  assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
  assert.match(preflight.headers.get("access-control-allow-headers"), /content-type/);
});

test("API rejects missing files and invalid filters", async () => {
  const missing = new FormData();
  missing.append("filters", "[]");
  const missingResponse = await fetch(`${url}/api/process`, { method: "POST", body: missing });
  assert.equal(missingResponse.status, 400);
  assert.match((await missingResponse.json()).error, /required/);
  const invalid = new FormData();
  invalid.append("video", new Blob([await readFile(input)]), "clip.mp4");
  invalid.append("filters", '[{"type":"brightness","value":999}]');
  const invalidResponse = await fetch(`${url}/api/process`, { method: "POST", body: invalid });
  assert.equal(invalidResponse.status, 400);
  assert.match((await invalidResponse.json()).error, /Invalid filters/);
});

test("processing reports invalid input, engine failures, and cancellation", { timeout: 10000 }, async () => {
  const invalid = join(directory, "invalid.mp4");
  await writeFile(invalid, "not a video");
  await assert.rejects(processVideo(invalid, join(directory, "invalid-out.mp4"), "none"));
  await assert.rejects(processVideo(input, join(directory, "invalid-threads.mp4"), "none", { threads: 0 }));
  await assert.rejects(processVideo(input, join(directory, "engine-failed.mp4"), "blur"));
  await assert.rejects(processVideo(input, join(directory, "cancelled.mp4"), "none", {
    signal: AbortSignal.abort(),
  }), { name: "AbortError" });
});
