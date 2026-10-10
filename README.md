# CPU video processing baseline

A minimal Next.js UI, Node.js API, and C++ frame-processing engine. No explicit
SIMD, GPU code, job service, or database.

## Run locally

Requires Node.js 20.9+, npm, CMake 3.16+, a C++20 compiler, and `ffmpeg`/`ffprobe`
on PATH. FFmpeg must include the `libx264` and AAC encoders.

From this directory, build the engine:

```sh
cmake -S processing-engine -B processing-engine/build -DCMAKE_BUILD_TYPE=Release
cmake --build processing-engine/build -j
```

Start the API in one terminal:

```sh
cd backend
npm install
npm run dev
```

Start the UI in another:

```sh
cd frontend
npm install
npm run dev
```

Open http://localhost:3000. Add grayscale, invert, or brightness steps and use
Up/Down to order them. An empty flow simply re-encodes the video.

## Pipeline

```text
Next.js same-origin multipart upload (video + ordered JSON filters)
  -> Next.js proxies /api/process to the local Node API
  -> Node API saves the upload to a temporary directory
  -> FFmpeg decodes RGB24 frames into the C++ engine's stdin
  -> reader assigns frame indices and feeds a thread-safe work queue
  -> C++ workers apply the complete filter flow to each frame
  -> writer emits completed frames in index order to stdout
  -> FFmpeg encodes MP4, including the original's first audio track as AAC
  -> Node returns the MP4 and deletes temporary files
```

The engine uses a mutex and condition variable, not busy waiting. At most
`2 * worker count` frames are in flight across the queue, workers, and reorder
buffer, so memory does not grow with video duration. Stream backpressure also
stops decoding when the engine or encoder falls behind.

The API spawns one pipeline per request. `THREADS` sets the C++ worker count
(1-32, default: up to 4 available CPUs). FFmpeg output encoding threads are
limited separately. This is a local baseline, not a benchmark or production
service; concurrent requests can oversubscribe the CPU.

## API

`GET http://localhost:4000/health` checks that the API is running.
`POST /api/process` accepts one `video` file (up to 250 MB) and a `filters`
multipart field containing an ordered JSON array (up to 16 steps).

```sh
curl --fail-with-body http://localhost:4000/api/process \
  -F 'video=@clip.mp4' \
  -F 'filters=[{"type":"brightness","value":20},{"type":"grayscale"},{"type":"invert"}]' \
  --output processed.mp4
```

Brightness is an additive percentage of 255, clamped per RGB channel; values
range from -100 to 100. Each step is applied in the given order.

Backend settings: `PORT` (4000), `FRONTEND_ORIGIN` (`*`, allowing any origin
for this local baseline), and `THREADS`. Set `FRONTEND_ORIGIN` to a specific
frontend origin to restrict CORS. The API binds to loopback for local use.
Next.js server setting: `API_URL` (http://127.0.0.1:4000). Browser requests
use the frontend's own origin, so only the frontend port needs forwarding.
The proxy allows ten minutes of inactivity while the backend processes a video.

## Baseline limitations

- Videos are normalized to their average frame rate; variable-frame-rate
  timestamps are not retained.
- Output is 8-bit RGB filtering followed by H.264/YUV420 MP4. Odd dimensions are
  padded to even dimensions. HDR, original metadata, subtitles, additional
  audio tracks, rotation metadata, and pixel aspect ratio are not preserved.
- Rotation is not applied; filtering uses the encoded frame dimensions.
- Uploads and finished files use temporary disk space; browser previews use
  object URLs, and the returned file is held in browser memory.
- No performance claims yet. Decoding, encoding, and pipe copies may dominate;
  this setup isolates the C++ filter loop for later CPU optimization.

## Checks

After building the engine and installing dependencies:

```sh
cd backend
npm test
cd ../frontend
npm run lint
npm run build
```

The backend tests use real FFmpeg clips and the compiled engine, including
byte-exact single/multi-worker comparisons and multipart API requests.
