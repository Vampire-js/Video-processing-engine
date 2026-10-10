# Video lab frontend

Run `npm install` and `npm run dev`, then open http://localhost:3000.
The Node API must also be running on http://localhost:4000.

Upload a video, add and reorder filters, then process it to preview and download
the result. Browser requests use `/api/process` on the same origin as the page;
Next.js proxies them to the Node API. This also works through forwarded URLs
without exposing port 4000 or configuring browser CORS.

`API_URL` overrides the server-side API address (default:
`http://127.0.0.1:4000`); set it before starting or building Next.js. The proxy
allows up to ten minutes of inactivity while the backend processes a video.

See [the project README](../README.md) for engine build and backend setup.
