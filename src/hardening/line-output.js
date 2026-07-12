import { StringDecoder } from "node:string_decoder";
import { Writable } from "node:stream";
import {
  SAFE_OUTPUT_FALLBACK,
  freeformSegment,
  renderTerminalSegments,
} from "./output-policy.js";

const MAX_LINE_CODE_UNITS = 65_536;

export function createSanitizedLineWriter({ write } = {}) {
  if (typeof write !== "function") throw new TypeError("line output write function is required");

  let destinationQueue = Promise.resolve();
  const enqueue = (stream, buffer) => {
    destinationQueue = destinationQueue.then(() => write(stream, buffer));
    // A caller may end both endpoints before awaiting finished(). Keep the
    // serialized queue rejection observed during that interval.
    destinationQueue.catch(() => {});
  };

  const stdout = createEndpoint("stdout", enqueue);
  const stderr = createEndpoint("stderr", enqueue);
  const stdoutFinished = endpointFinished(stdout);
  const stderrFinished = endpointFinished(stderr);

  return {
    stdout,
    stderr,
    async finished() {
      await Promise.all([stdoutFinished, stderrFinished]);
      await destinationQueue;
    },
  };
}

function createEndpoint(stream, enqueue) {
  const decoder = new StringDecoder("utf8");
  const state = {
    content: [],
    contentLength: 0,
    pendingCarriageReturn: false,
    discardingOversizedLine: false,
  };

  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        consumeDecodedText(decoder.write(chunk), stream, state, enqueue);
        callback();
      } catch {
        callback(new Error("Sanitized line processing failed safely."));
      }
    },
    final(callback) {
      try {
        consumeDecodedText(decoder.end(), stream, state, enqueue);
        flushFinalFragment(stream, state, enqueue);
        callback();
      } catch {
        callback(new Error("Sanitized line processing failed safely."));
      }
    },
  });
}

function consumeDecodedText(text, stream, state, enqueue) {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text[index];

    if (codeUnit === "\n") {
      if (!state.discardingOversizedLine) emitLine(stream, state.content.join(""), true, enqueue);
      resetLine(state);
      continue;
    }

    if (state.discardingOversizedLine) continue;

    if (state.pendingCarriageReturn) {
      state.pendingCarriageReturn = false;
      appendCodeUnit("\r", stream, state, enqueue);
      if (state.discardingOversizedLine) continue;
    }

    if (codeUnit === "\r") state.pendingCarriageReturn = true;
    else appendCodeUnit(codeUnit, stream, state, enqueue);
  }
}

function appendCodeUnit(codeUnit, stream, state, enqueue) {
  if (state.contentLength >= MAX_LINE_CODE_UNITS) {
    state.content = [];
    state.contentLength = 0;
    state.pendingCarriageReturn = false;
    state.discardingOversizedLine = true;
    enqueue(stream, Buffer.from(`[feature-factory] oversized ${stream} line redacted\n`, "utf8"));
    return;
  }
  state.content.push(codeUnit);
  state.contentLength += 1;
}

function flushFinalFragment(stream, state, enqueue) {
  if (state.discardingOversizedLine) return;
  if (state.pendingCarriageReturn) {
    state.pendingCarriageReturn = false;
    appendCodeUnit("\r", stream, state, enqueue);
  }
  if (!state.discardingOversizedLine && state.contentLength > 0) {
    emitLine(stream, state.content.join(""), false, enqueue);
  }
  resetLine(state);
}

function emitLine(stream, content, delimited, enqueue) {
  let rendered;
  try {
    rendered = renderTerminalSegments([freeformSegment(content)]);
  } catch {
    rendered = SAFE_OUTPUT_FALLBACK;
  }
  enqueue(stream, Buffer.from(delimited ? `${rendered}\n` : rendered, "utf8"));
}

function resetLine(state) {
  state.content = [];
  state.contentLength = 0;
  state.pendingCarriageReturn = false;
  state.discardingOversizedLine = false;
}

function endpointFinished(endpoint) {
  const completion = new Promise((resolve, reject) => {
    endpoint.once("finish", resolve);
    endpoint.once("error", reject);
  });
  completion.catch(() => {});
  return completion;
}
