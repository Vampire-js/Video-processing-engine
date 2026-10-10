"use client";

import { useEffect, useRef, useState } from "react";

type Filter =
  | { type: "grayscale" | "invert" }
  | { type: "brightness"; value: number };

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [original, setOriginal] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [completedFlow, setCompletedFlow] = useState("");
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => { if (original) URL.revokeObjectURL(original); };
  }, [original]);

  useEffect(() => {
    return () => { if (result) URL.revokeObjectURL(result); };
  }, [result]);

  useEffect(() => {
    return () => activeRequest.current?.abort();
  }, []);

  function moveFilter(index: number, direction: number) {
    setFilters((current) => {
      const next = [...current];
      const target = index + direction;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function processVideo(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    setResult("");
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const data = new FormData();
      data.append("video", file);
      data.append("filters", JSON.stringify(filters));
      const response = await fetch("/api/process", {
        method: "POST", body: data, signal: controller.signal,
      });
      if (!response.ok) {
        const contentType = response.headers.get("content-type") ?? "";
        const message = contentType.includes("application/json")
          ? (await response.json()).error : `Request failed (${response.status}).`;
        throw new Error(message);
      }
      setResult(URL.createObjectURL(await response.blob()));
      setCompletedFlow(filters.map((filter) => filter.type === "brightness"
        ? `brightness (${filter.value > 0 ? "+" : ""}${filter.value}%)`
        : filter.type).join(" -> ") || "No filters");
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Video processing failed.");
      }
    } finally {
      activeRequest.current = null;
      setBusy(false);
    }
  }

  return (
    <main className="workspace">
      <header>
        <span className="eyebrow">CPU PROCESSING / BASELINE</span>
        <h1>Video lab</h1>
        <p>Upload a clip, build a filter flow, and let the CPU do the work.</p>
      </header>

      <form onSubmit={processVideo}>
        <fieldset disabled={busy}>
          <section className="panel">
            <h2>1. Choose a video</h2>
            <label className="upload">
              <span>Choose a video file</span>
              <input type="file" accept="video/*" required onChange={(event) => {
                const selected = event.target.files?.[0] ?? null;
                setResult("");
                setError("");
                if (selected && selected.size > 250 * 1024 * 1024) {
                  setFile(null);
                  setOriginal("");
                  setError("Video must be 250 MB or smaller.");
                  return;
                }
                setFile(selected);
                setOriginal(selected ? URL.createObjectURL(selected) : "");
              }} />
              <small>Up to 250 MB. Output is H.264 MP4.</small>
            </label>
            {file && <p className="file-info">{file.name} / {(file.size / 1024 / 1024).toFixed(1)} MB</p>}
          </section>

          <section className="panel">
            <h2>2. Build your filter flow</h2>
            <p>Steps run from top to bottom on every frame.</p>
            <div className="filter-buttons">
              {(["grayscale", "invert", "brightness"] as const).map((type) => (
                <button key={type} type="button" disabled={filters.length >= 16}
                  onClick={() => setFilters([...filters, type === "brightness"
                    ? { type, value: 20 } : { type }])}>
                  + {type}
                </button>
              ))}
            </div>
            {filters.length === 0 && <p className="empty">No filters yet. You can also just re-encode the original.</p>}
            <ol className="flow">
              {filters.map((filter, index) => (
                <li key={index}>
                  <span className="step">{index + 1}</span>
                  <span className="filter-name">{filter.type}</span>
                  {filter.type === "brightness" && (
                    <label className="brightness">
                      <input type="range" min="-100" max="100" value={filter.value}
                        aria-label={`Brightness for step ${index + 1}`}
                        onChange={(event) => setFilters(filters.map((step, position) =>
                          position === index ? { type: "brightness", value: Number(event.target.value) } : step))} />
                      <span>{filter.value > 0 ? "+" : ""}{filter.value}%</span>
                    </label>
                  )}
                  <div className="step-actions">
                    <button type="button" disabled={index === 0} onClick={() => moveFilter(index, -1)}
                      aria-label={`Move step ${index + 1} up`}>Up</button>
                    <button type="button" disabled={index === filters.length - 1} onClick={() => moveFilter(index, 1)}
                      aria-label={`Move step ${index + 1} down`}>Down</button>
                    <button type="button" onClick={() => setFilters(filters.filter((_, position) => position !== index))}
                      aria-label={`Remove step ${index + 1}`}>Remove</button>
                  </div>
                </li>
              ))}
            </ol>
          </section>
          <button className="primary" type="submit" disabled={!file || busy}>
            {busy ? "Processing video..." : "Process video"}
          </button>
        </fieldset>
        <p className="status" role="status">{busy ? "Uploading, filtering, and encoding. This may take a little while." : ""}</p>
        {error && <p className="error" role="alert">{error}</p>}
      </form>

      {(original || result) && (
        <section className="previews">
          {original && <div className="panel"><h2>Original</h2><video src={original} controls preload="metadata" /></div>}
          {result && <div className="panel">
            <h2>Processed</h2>
            <video src={result} controls preload="metadata" />
            <p className="file-info">{completedFlow}</p>
            <a className="download" href={result} download="processed.mp4">Download MP4</a>
          </div>}
        </section>
      )}
      <footer>FFmpeg decode / C++ worker queue / ordered frames / FFmpeg encode</footer>
    </main>
  );
}
