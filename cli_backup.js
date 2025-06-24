#!/usr/bin/env node

// cli.js: Stream a WAV file to OpenAI Realtime API and record the combined conversation.

import fs from "fs";
import fetch from "node-fetch";
import minimist from "minimist";
import pkg from "wrtc";
const { RTCPeerConnection, nonstandard } = pkg;
import "dotenv/config";
import wav from "wav";

(async () => {
  // Parse command-line arguments
  const argv = minimist(process.argv.slice(2), {
    string: ["input", "output", "model"],
    alias: { i: "input", o: "output", m: "model" },
  });

  // Normalize input path
  const inputRaw = argv.input;
  const inputPath = Array.isArray(inputRaw) ? inputRaw[inputRaw.length - 1] : inputRaw;

  // Normalize output path
  const outputRaw = argv.output;
  const outputPath = Array.isArray(outputRaw) ? outputRaw[outputRaw.length - 1] : outputRaw || "combined.wav";

  const model = argv.model || "gpt-4o-realtime-preview-2024-12-17";

  if (!inputPath) {
    console.error(
      "Usage: cli.js --input <path/to.wav> [--output <out.wav>] [--model <model-name>]"
    );
    process.exit(1);
  }

  // Read and decode WAV
  const reader = new wav.Reader();
  const inStream = fs.createReadStream(inputPath);
  let format;
  const pcmChunks = [];

  reader.on("format", (fmt) => {
    format = fmt;
  });
  reader.on("data", (data) => pcmChunks.push(data));

  await new Promise((resolve) => {
    reader.on("end", resolve);
    inStream.pipe(reader);
  });

  if (!format) {
    console.error("Failed to parse WAV format from input file.");
    process.exit(1);
  }

  // Flatten samples to Int16Array (downmix to mono)
  let samples;
  const { sampleRate: origSampleRate, bitDepth, channels } = format;
  const bytesPerSample = bitDepth / 8;
  const totalFrames = Buffer.concat(pcmChunks).length / (bytesPerSample * channels);
  samples = new Int16Array(totalFrames);
  const buffer = Buffer.concat(pcmChunks);
  for (let i = 0; i < totalFrames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const offset = (i * channels + c) * bytesPerSample;
      const sample = bitDepth === 32
        ? Math.round(Math.max(-1, Math.min(1, buffer.readFloatLE(offset))) * 32767)
        : buffer.readInt16LE(offset);
      acc += sample;
    }
    samples[i] = Math.round(acc / channels);
  }

  // Resample to 48000 Hz
  const targetRate = 48000;
  let resampled;
  if (origSampleRate !== targetRate) {
    const ratio = targetRate / origSampleRate;
    const newLen = Math.floor(samples.length * ratio);
    resampled = new Int16Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const idx = i / ratio;
      const i0 = Math.floor(idx);
      const i1 = Math.min(i0 + 1, samples.length - 1);
      const frac = idx - i0;
      resampled[i] = Math.round(samples[i0] * (1 - frac) + samples[i1] * frac);
    }
  } else {
    resampled = samples;
  }

  // Build PCM buffer
  const inputPcm = Buffer.alloc(resampled.length * 2);
  for (let i = 0; i < resampled.length; i++) {
    inputPcm.writeInt16LE(resampled[i], i * 2);
  }

  const sampleRate = targetRate;
  const frameSize = sampleRate / 100; // 480 samples
  const frameBytes = frameSize * 2;

  // Session token
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Missing OPENAI_API_KEY in .env");
    process.exit(1);
  }
  const sess = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, voice: "verse" }),
  });
  const tokData = await sess.json();
  if (!tokData.client_secret?.value) {
    console.error("Failed to obtain session token:", tokData);
    process.exit(1);
  }
  const token = tokData.client_secret.value;

  // WebRTC setup
  const pc = new RTCPeerConnection();
  const source = new nonstandard.RTCAudioSource();
  const track = source.createTrack();
  pc.addTrack(track);
  const gptBuffers = [];  // { samples: Int16Array, time: bigint }
  let done = false;

  pc.ontrack = ({ track: incomingTrack }) => {
    const sink = new nonstandard.RTCAudioSink(incomingTrack);
    sink.ondata = ({ samples }) => {
      gptBuffers.push({ samples: new Int16Array(samples), time: process.hrtime.bigint() });
    };
  };

  const dc = pc.createDataChannel("oai_events");
  dc.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "response.done") done = true;
  };

  // SDP exchange
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const sigRes = await fetch(`https://api.openai.com/v1/realtime?model=${model}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/sdp" },
    body: offer.sdp,
  });
  const ans = await sigRes.text();
  await pc.setRemoteDescription({ type: "answer", sdp: ans });

  // Prepare WAV writer for real-time recording
  const writer = new wav.Writer({ sampleRate, channels: 1, bitDepth: 16 });
  const outStream = fs.createWriteStream(outputPath);
  writer.pipe(outStream);

  // Record start time and Stream input
  const startTime = process.hrtime.bigint();
  for (let off = 0; off < inputPcm.length; off += frameBytes) {
    let chunk = inputPcm.slice(off, off + frameBytes);
    if (chunk.length < frameBytes) {
      const pad = Buffer.alloc(frameBytes - chunk.length);
      chunk = Buffer.concat([chunk, pad]);
    }
    const temp = new Int16Array(chunk.buffer, chunk.byteOffset, frameSize);
    const frame = Int16Array.from(temp);
    source.onData({ samples: frame, sampleRate, bitsPerSample: 16, channelCount: 1 });
    await new Promise((r) => setTimeout(r, 10));
  }

  // Signal end of input
  track.stop();
  track.stop();

  // Wait
  while (!done) await new Promise((r) => setTimeout(r, 50));

      // Mix input and GPT response into a single output buffer
  const inputSamples = new Int16Array(inputPcm.buffer);
  // Compute offsets per GPT buffer
  let maxIndex = inputSamples.length;
  const offsets = gptBuffers.map(({ time }) => {
    const delta = Number(time - startTime) / 1e6; // ms
    return Math.round((delta * sampleRate) / 1000);
  });
  gptBuffers.forEach(({ samples }, idx) => {
    const pos = offsets[idx];
    maxIndex = Math.max(maxIndex, pos + samples.length);
  });
  const outputSamples = new Int16Array(maxIndex);
  outputSamples.set(inputSamples);
  gptBuffers.forEach(({ samples }, idx) => {
    const pos = offsets[idx];
    for (let i = 0; i < samples.length; i++) {
      const j = pos + i;
      const sum = (outputSamples[j] || 0) + samples[i];
      outputSamples[j] = Math.max(-32768, Math.min(32767, sum));
    }
  });

  // Write mixed WAV
  const writer2 = new wav.Writer({ sampleRate, channels: 1, bitDepth: 16 });
  const outStream2 = fs.createWriteStream(outputPath);
  writer2.pipe(outStream2);
  writer2.write(Buffer.from(outputSamples.buffer));
  writer2.end();

  console.log(`Combined wav with mixed audio written to: ${outputPath}`);
})();
