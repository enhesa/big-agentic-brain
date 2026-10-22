// Preloaded by the Dockerfile (node --require ./collapse-slashes.cjs server.js).
// Next.js answers any path with repeated slashes (//api/hook) with a 308 to the clean path before
// proxy.ts runs, and a hook's curl does not follow it. A bab_url with a trailing slash produces
// exactly that. So the request URL is cleaned here, before Next sees it, and every later layer
// (gate, identity, routes) works on the clean path.
"use strict";
const http = require("node:http");

/** Collapses runs of slashes in the path of an origin-form request target. Query and fragment are kept. */
function collapseSlashes(url) {
  if (typeof url !== "string" || url.charAt(0) !== "/") return url;
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  const rest = cut === -1 ? "" : url.slice(cut);
  return path.replace(/\/{2,}/g, "/") + rest;
}

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req) {
  if ((event === "request" || event === "upgrade") && req && typeof req.url === "string") {
    req.url = collapseSlashes(req.url);
  }
  return emit.apply(this, arguments);
};

module.exports = { collapseSlashes };
