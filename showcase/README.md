# The showcase film

A 45 second motion graphic about Big Agentic Brain. It is drawn in code, so it can be changed and rendered again.

| File | What it is |
|---|---|
| `film.js` | The film. Every frame is drawn from its frame number alone, with no clock and no random numbers. |
| `index.html` | A page that plays the film in a browser, on a loop. |
| `render.mjs` | Renders the film to video with headless Chrome and ffmpeg. |

## Watch it while you edit

Serve the repository root with any static file server and open `/showcase/index.html`. The page needs the fonts in `public/fonts/`, so opening the file from disk may fall back to a system font.

```bash
npx serve .
# then open http://localhost:3000/showcase/index.html
```

## Render it

You need Chrome or Chromium, ffmpeg, and the Node version the project already uses. There is nothing to install from npm.

```bash
node showcase/render.mjs
```

It writes three files and prints their sizes:

| Output | Used by |
|---|---|
| `public/showcase.mp4` | The film itself |
| `public/showcase-poster.png` | The closing frame, shown before the film plays |
| `docs/images/showcase.gif` | The small copy at the top of the README |

Set `CHROME_PATH` or `FFMPEG_PATH` when they are not in the usual places. `CHROME_FLAGS` adds flags, for example `--no-sandbox` when you render as root in a container.

The render works in a temporary folder and replaces the three files only when all of it succeeded. The drawing is the same every time. The exact bytes can differ between machines, because browsers and ffmpeg builds smooth type and compress video differently.

Commit the three outputs with the source change. `tests/showcase.test.ts` keeps them small.

## Change it

- **Timing.** The `SCENES` list at the end of `film.js` holds the start and end of each scene, in seconds. Scenes overlap by 0.4 seconds to cross-fade.
- **Words.** Each scene draws its own caption with `say()`. Keep captions short: `say()` shrinks type that would run off the frame.
- **Numbers.** The measured scene repeats the figures in the main README. Change both together.
- **Colours and type.** The palette at the top of `film.js` matches `app/globals.css`. The fonts are the ones the app ships.
- **Keep it still where you can.** The backdrop does not move on purpose. A still backdrop keeps the GIF near one megabyte.
