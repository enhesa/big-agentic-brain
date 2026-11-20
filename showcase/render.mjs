#!/usr/bin/env node
/*
 * Renders the showcase film to video. No dependencies beyond Node, Chrome and ffmpeg.
 *
 *   node showcase/render.mjs
 *
 * It serves the film page on a local port, opens it in headless Chrome, asks the page for
 * every frame in turn, and pipes the frames to ffmpeg. It writes:
 *
 *   public/showcase.mp4          the film, for the landing page
 *   public/showcase-poster.png   the closing frame, shown before the film plays
 *   docs/images/showcase.gif     a small, silent copy for the README
 *
 * Everything is rendered into a temporary folder first, so a failed or interrupted run
 * leaves the committed files alone.
 *
 * Set CHROME_PATH or FFMPEG_PATH when they are not in the usual places, and CHROME_FLAGS
 * for extra flags (for example --no-sandbox when running as root in a container).
 */

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

console.log("== BAB showcase film: renders showcase/ to public/showcase.mp4 and docs/images/showcase.gif");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const out = {
  mp4: join(root, "public", "showcase.mp4"),
  poster: join(root, "public", "showcase-poster.png"),
  gif: join(root, "docs", "images", "showcase.gif"),
};

const STEP_TIMEOUT_MS = 30_000;

/** Fails when `promise` takes longer than the step timeout, so a wedged browser cannot hang the run. */
function within(promise, what) {
  let timer;
  const late = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(`Timed out after ${STEP_TIMEOUT_MS / 1000} s: ${what}`)), STEP_TIMEOUT_MS);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error("Chrome not found. Set CHROME_PATH to a Chrome or Chromium binary.");
  return found;
}

function checkFfmpeg() {
  const probe = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) throw new Error("ffmpeg not found. Install it, or set FFMPEG_PATH.");
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Serves showcase/ and public/fonts/ only, on a free local port. */
function serve() {
  const allowed = [join(root, "showcase") + sep, join(root, "public", "fonts") + sep];
  const server = createServer((req, res) => {
    let path;
    try {
      path = normalize(join(root, decodeURIComponent(new URL(req.url, "http://localhost").pathname)));
    } catch {
      res.writeHead(404).end();
      return;
    }
    const type = TYPES[extname(path)];
    if (!type || !allowed.some((dir) => path.startsWith(dir)) || !existsSync(path)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": type });
    createReadStream(path).pipe(res);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

/** Starts headless Chrome. `address` resolves with its DevTools address. */
function launch(chromePath, profile) {
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      // Close to the same pixels on every machine, as far as the browser allows.
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--disable-lcd-text",
      "--window-size=1280,720",
      ...(process.env.CHROME_FLAGS ?? "").split(/\s+/).filter(Boolean),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const address = new Promise((done, fail) => {
    let seen = "";
    const read = (chunk) => {
      seen += chunk;
      const match = seen.match(/DevTools listening on (ws:\/\/\S+)/);
      if (!match) return;
      chrome.stderr.off("data", read);
      chrome.stderr.resume();
      done(match[1]);
    };
    chrome.stderr.on("data", read);
    chrome.on("error", fail);
    chrome.on("exit", (code) => fail(new Error(`Chrome exited early with code ${code}:\n${seen.slice(-500)}`)));
  });
  return { chrome, address };
}

/** A minimal DevTools Protocol client over Node's own WebSocket. */
function connect(address) {
  const socket = new WebSocket(address);
  const waiting = new Map();
  let next = 1;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    if (message.error) entry.fail(new Error(message.error.message));
    else entry.done(message.result);
  });
  // A browser that dies mid-render fails every call still waiting, instead of hanging them.
  socket.addEventListener("close", () => {
    for (const entry of waiting.values()) entry.fail(new Error("Chrome closed the DevTools connection"));
    waiting.clear();
  });
  const send = (method, params = {}, sessionId) =>
    within(
      new Promise((done, fail) => {
        const id = next++;
        waiting.set(id, { done, fail });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      }),
      method,
    );
  return new Promise((done, fail) => {
    socket.addEventListener("open", () => done({ send, close: () => socket.close() }));
    socket.addEventListener("error", () => fail(new Error("Could not reach Chrome's DevTools port")));
  });
}

function run(command, args) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`${command} failed:\n${errors.slice(-2000)}`))));
  });
}

const kb = (path) => `${Math.round(statSync(path).size / 1024)} KB`;

checkFfmpeg();
const chromePath = findChrome();
const work = mkdtempSync(join(tmpdir(), "bab-showcase-"));
const draft = { mp4: join(work, "showcase.mp4"), poster: join(work, "poster.png"), gif: join(work, "showcase.gif") };
let server;
let chrome;
let encoder;

// Also on Ctrl+C or a crash: never leave a browser or an encoder running.
const stopChildren = () => {
  chrome?.kill();
  encoder?.kill();
};
process.on("exit", stopChildren);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopChildren();
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      // Chrome may still hold its profile. The folder is in the system's temporary directory.
    }
    process.exit(130);
  });
}

try {
  server = await serve();
  const browser = launch(chromePath, join(work, "profile"));
  chrome = browser.chrome;
  const devtools = await connect(await within(browser.address, "waiting for Chrome to start"));

  const page = `http://127.0.0.1:${server.address().port}/showcase/index.html?render=1`;
  const { targetId } = await devtools.send("Target.createTarget", { url: page });
  const { sessionId } = await devtools.send("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await devtools.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };

  // The page script may not have run yet: wait for it, then for its fonts.
  for (let tries = 0; (await evaluate("typeof window.filmReady")) === "undefined"; tries++) {
    if (tries > 100) throw new Error("The film page did not load");
    await new Promise((wait) => setTimeout(wait, 100));
  }
  await evaluate("window.filmReady");
  const fonts = await evaluate(`[...document.fonts].map((face) => face.family + " " + face.status)`);
  if (fonts.length < 2 || !fonts.every((font) => font.endsWith(" loaded"))) {
    throw new Error(`The film's fonts did not load from public/fonts/ (${fonts.join(", ") || "none found"})`);
  }
  const film = await evaluate("window.film");
  const frame = async (n) => {
    const url = await evaluate(`renderFrame(${n}); document.getElementById("film").toDataURL("image/png")`);
    return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  };

  encoder = spawn(
    ffmpeg,
    [
      "-y", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(film.fps), "-c:v", "png", "-i", "-",
      "-c:v", "libx264", "-preset", "veryslow", "-crf", "24", "-tune", "animation",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
      draft.mp4,
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  // If ffmpeg dies early, stop feeding it and report its exit. The broken pipe says nothing more.
  let encoderFailure;
  const encoded = new Promise((done, fail) => {
    encoder.on("error", fail);
    encoder.on("exit", (code) => (code === 0 ? done() : fail(new Error(`ffmpeg exited with code ${code}`))));
  }).catch((error) => {
    encoderFailure = error;
  });
  encoder.stdin.on("error", () => {});

  for (let n = 0; n < film.frames && !encoderFailure; n++) {
    const png = await frame(n);
    if (!encoder.stdin.write(png)) {
      await Promise.race([new Promise((drained) => encoder.stdin.once("drain", drained)), encoded]);
    }
    if (n % 150 === 0) console.log(`frame ${n} of ${film.frames}`);
  }
  encoder.stdin.end();
  await encoded;
  if (encoderFailure) throw encoderFailure;

  writeFileSync(draft.poster, await frame(film.frames - 1));

  // The README copy: smaller, fewer frames, one shared palette. Flat colour keeps it light.
  await run(ffmpeg, [
    "-y", "-loglevel", "error", "-i", draft.mp4,
    "-vf",
    "fps=8,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=24:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
    draft.gif,
  ]);

  for (const name of ["mp4", "poster", "gif"]) copyFileSync(draft[name], out[name]);
  console.log(`public/showcase.mp4          ${kb(out.mp4)}`);
  console.log(`public/showcase-poster.png   ${kb(out.poster)}`);
  console.log(`docs/images/showcase.gif     ${kb(out.gif)}`);
  devtools.close();
} finally {
  chrome?.removeAllListeners("exit");
  stopChildren();
  server?.close();
  // Give Chrome a moment to let go of its profile before removing it.
  await new Promise((wait) => setTimeout(wait, 500));
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`Could not remove the temporary folder at ${work}`);
  }
}
