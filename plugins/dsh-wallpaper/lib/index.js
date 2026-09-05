/**
 * dsh-wallpaper — host half.
 *
 * Registers one HTTP route on the DSH web server:
 *
 *   GET /dsh-wallpaper/read?path=/absolute/path/to/image.jpg
 *     → 200 { dataUrl: "data:image/...;base64,..." }
 *     → 400 unsupported-path / 413 too-large / 404 read-failed / 403 origin
 *
 * This lets the browser-side plugin load an image by its full absolute path
 * (the browser sandbox cannot read local files itself). Only image
 * extensions are accepted, the file size is capped, and cross-origin callers
 * are rejected. Requires a dsh web restart to take effect (host plugins are
 * loaded at boot).
 */
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";

const inject = ["webServer"];

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".svg"]);
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};
const MAX_BYTES = 24 * 1024 * 1024;

function respond(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/dsh-wallpaper/read",
        handler: async (req, res) => {
          try {
            // Only same-origin callers (the DSH UI itself).
            const origin = (req.headers.origin || req.headers.referer || "").replace(/\/+$/, "");
            if (origin !== "" && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
              respond(res, 403, { error: "origin-rejected" });
              return;
            }
            const url = new URL(req.url || "/", "http://127.0.0.1");
            const raw = url.searchParams.get("path") || "";
            const path = resolve(raw);
            const ext = extname(path).toLowerCase();
            if (!isAbsolute(path) || !IMAGE_EXT.has(ext)) {
              respond(res, 400, { error: "unsupported-path" });
              return;
            }
            const buf = await readFile(path);
            if (buf.byteLength > MAX_BYTES) {
              respond(res, 413, { error: "too-large" });
              return;
            }
            respond(res, 200, {
              dataUrl: `data:${MIME[ext]};base64,${buf.toString("base64")}`,
            });
          } catch (err) {
            respond(res, 404, {
              error: "read-failed",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        },
      }),
    "dsh-wallpaper: /read route",
  );
}

export { apply, inject };
