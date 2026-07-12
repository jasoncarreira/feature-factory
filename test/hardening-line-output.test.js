import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSanitizedLineWriter } from "../src/hardening/line-output.js";

const STREAMS = ["stdout", "stderr"];

describe("createSanitizedLineWriter framing", () => {
  const cases = [
    ["LF", ["foo\n"], "666f6f0a"],
    ["CRLF", ["foo\r\n"], "666f6f0a"],
    ["lone CR", ["foo\rbar\n"], "666f6f5c75303030446261720a"],
    ["EOF trailing CR", ["foo\r"], "666f6f5c7530303044"],
    ["CR CRLF", ["foo\r\r\n"], "666f6f5c75303030440a"],
    ["empty CRLF line", ["\r\n"], "0a"],
    ["EOF fragment", ["foo"], "666f6f"],
    ["split CRLF", ["foo\r", "\n"], "666f6f0a"],
    ["split lone CR", ["foo\r", "bar\n"], "666f6f5c75303030446261720a"],
  ];

  for (const stream of STREAMS) {
    for (const [name, chunks, expectedHex] of cases) {
      it(`${stream}: renders ${name} as exact bytes`, async () => {
        const writes = await renderChunks(stream, chunks);
        const actual = Buffer.concat(writes.map((entry) => entry.buffer));
        const expected = Buffer.from(expectedHex, "hex");
        assert.deepEqual(actual, expected);
        assert.equal(actual.length, expected.length);
        assert.equal(actual.includes(0x0D), false);
        assert.deepEqual(writes.map((entry) => entry.stream), [stream]);
      });
    }
  }

  it("retains split UTF-8, credentials, and controls until a complete record is safe", async () => {
    const writes = [];
    const writer = createSanitizedLineWriter({ write: (stream, buffer) => writes.push({ stream, buffer }) });
    const credential = "dXNlcjpwYXNz==";
    const source = Buffer.from(`Authorization: Basic ${credential}\u001B]52;c;AAAA\u0007\u009Bé\n`, "utf8");
    writer.stdout.write(source.subarray(0, source.length - 2));
    writer.stdout.end(source.subarray(source.length - 2));
    writer.stderr.end();
    await writer.finished();

    const actual = Buffer.concat(writes.map((entry) => entry.buffer));
    assert.equal(actual.toString("utf8"), "Authorization: Basic [redacted]\\u001B]52;c;AAAA\\u0007\\u009Bé\n");
    assert.equal(actual.includes(Buffer.from(credential)), false);
    for (const byte of [0x0D, 0x1B, 0x07]) assert.equal(actual.includes(byte), false);
    assert.equal(actual.includes(Buffer.from("\u009B", "utf8")), false);
  });
});

describe("createSanitizedLineWriter bounds and queueing", () => {
  for (const stream of STREAMS) {
    it(`${stream}: renders exactly 65,536 code units`, async () => {
      const content = "a ".repeat(32_768);
      const writes = await renderChunks(stream, [`${content}\n`]);
      const actual = Buffer.concat(writes.map((entry) => entry.buffer));
      const expected = Buffer.from(`${content}\n`);
      assert.deepEqual(actual, expected);
      assert.equal(actual.length, 65_537);
      assert.equal(actual.includes(0x0D), false);
    });

    it(`${stream}: emits one exact marker and discards an oversized source line`, async () => {
      const writes = await renderChunks(stream, ["a".repeat(65_536), "\rb-secret", "\nstill safe\n"]);
      const actual = Buffer.concat(writes.map((entry) => entry.buffer));
      const expected = Buffer.from(`[feature-factory] oversized ${stream} line redacted\nstill safe\n`);
      assert.deepEqual(actual, expected);
      assert.equal(actual.length, expected.length);
      assert.equal(actual.includes(0x0D), false);
      assert.equal(actual.includes(Buffer.from("b-secret")), false);
    });
  }

  it("keeps stream buffers independent and serializes writes by callback arrival", async () => {
    const calls = [];
    let releaseFirst;
    const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
    const writer = createSanitizedLineWriter({
      async write(stream, buffer) {
        calls.push(`${stream}:start:${buffer.toString("utf8")}`);
        if (calls.length === 1) await firstPending;
        calls.push(`${stream}:end:${buffer.toString("utf8")}`);
      },
    });

    writer.stderr.write("err-part");
    writer.stdout.write("out\n");
    writer.stderr.end("-done\n");
    writer.stdout.end("last");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["stdout:start:out\n"]);
    releaseFirst();
    await writer.finished();
    assert.deepEqual(calls, [
      "stdout:start:out\n", "stdout:end:out\n",
      "stderr:start:err-part-done\n", "stderr:end:err-part-done\n",
      "stdout:start:last", "stdout:end:last",
    ]);
  });

  it("rejects finished after a destination failure without attempting later writes", async () => {
    const calls = [];
    const failure = new Error("destination unavailable");
    const writer = createSanitizedLineWriter({
      write(stream, buffer) {
        calls.push([stream, buffer]);
        throw failure;
      },
    });
    writer.stdout.end("source-secret\nsecond-source-secret\n");
    writer.stderr.end("stderr-source-secret\n");
    await assert.rejects(writer.finished(), (error) => error === failure);
    assert.equal(calls.length, 1);
  });
});

async function renderChunks(stream, chunks) {
  const writes = [];
  const writer = createSanitizedLineWriter({
    write(outputStream, buffer) {
      assert.equal(Buffer.isBuffer(buffer), true);
      writes.push({ stream: outputStream, buffer: Buffer.from(buffer) });
    },
  });
  const endpoint = writer[stream];
  for (const chunk of chunks.slice(0, -1)) endpoint.write(chunk);
  endpoint.end(chunks.at(-1));
  writer[stream === "stdout" ? "stderr" : "stdout"].end();
  await writer.finished();
  return writes;
}
