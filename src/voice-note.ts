import { spawn } from "node:child_process";

export const VOICE_NOTE_MIMETYPE = "audio/ogg; codecs=opus";

// OGG/Opus mono 48 kHz is the format WhatsApp clients play as a voice note (PTT).
const VOICE_NOTE_FFMPEG_ARGS = [
  "-hide_banner",
  "-loglevel",
  "error",
  "-i",
  "pipe:0",
  "-vn",
  "-c:a",
  "libopus",
  "-b:a",
  "64000",
  "-ar",
  "48000",
  "-ac",
  "1",
  "-application",
  "audio",
  "-map_metadata",
  "-1",
  "-f",
  "ogg",
  "pipe:1",
];

export function transcodeToVoiceNote(
  input: Buffer,
  ffmpegPath = process.env["FFMPEG_PATH"] || "ffmpeg",
  timeoutMs = 60_000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, VOICE_NOTE_FFMPEG_ARGS, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    // ffmpeg may exit before reading all input; the close handler reports the real failure.
    proc.stdin.on("error", () => undefined);
    proc.on("error", reject);
    proc.on("close", (code, signal) => {
      const output = Buffer.concat(stdout);
      if (code === 0 && output.byteLength > 0) {
        resolve(output);
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim().slice(-500);
      reject(
        new Error(
          `ffmpeg voice-note transcode failed (${signal ?? `exit ${code}`})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
    proc.stdin.end(input);
  });
}

// Opus granule positions always count 48 kHz samples; the last page holds the
// total, minus the encoder pre-skip declared in the OpusHead packet.
export function getOggOpusDurationSeconds(ogg: Buffer): number | null {
  const lastPage = ogg.lastIndexOf("OggS");
  const opusHead = ogg.indexOf("OpusHead");
  if (lastPage < 0 || opusHead < 0 || lastPage + 14 > ogg.length) return null;
  if (opusHead + 12 > ogg.length) return null;

  const granule = Number(ogg.readBigInt64LE(lastPage + 6));
  const preSkip = ogg.readUInt16LE(opusHead + 10);
  const samples = granule - preSkip;
  if (!Number.isFinite(samples) || samples <= 0) return null;

  return Math.max(1, Math.round(samples / 48_000));
}
