/**
 * Speaking out loud on this Mac.
 *
 * The cloud side cannot make noise here, and it cannot hand the bridge a URL to
 * fetch either: synthesizeSpeech requires a Firebase ID token and the bridge
 * holds a service account, not a user credential. So onCalendarChange
 * synthesizes the audio itself and ships the MP3 down inside the queue document
 * as base64 — a one-sentence clip is around 25KB, well under Firestore's 1MB
 * document ceiling.
 *
 * `say` is the fallback rather than the default because the whole point of the
 * ElevenLabs path is that an alert should sound like Maisie and not like the
 * system voice.
 */

import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** Long enough for any alert we generate; guards against a wedged afplay. */
const PLAYBACK_TIMEOUT_MS = 60_000;

/**
 * Pick a file extension from the audio's magic bytes.
 *
 * afplay refuses a file whose extension disagrees with its contents — writing
 * AAC bytes to `alert.mp3` fails with AudioFileOpen 'dta?' rather than falling
 * back to sniffing. Hardcoding `.mp3` therefore made playback quietly dependent
 * on ElevenLabs never changing its response format, with the only symptom being
 * an alert that arrives in the system voice instead of Maisie's.
 */
function extensionFor(buf: Buffer): string {
  if (buf.length >= 12) {
    const ascii = (start: number, end: number) => buf.subarray(start, end).toString("ascii");
    if (ascii(0, 3) === "ID3") return "mp3";
    if (ascii(4, 8) === "ftyp") return "m4a";
    if (ascii(0, 4) === "RIFF") return "wav";
    if (ascii(0, 4) === "FORM") return "aiff";
    if (ascii(0, 4) === "OggS") return "ogg";
    // Bare MPEG frame sync: 11 set bits.
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  }
  return "mp3"; // ElevenLabs' documented format, and the common case
}

/**
 * Play an ElevenLabs MP3. Returns false if playback could not be attempted, so
 * the caller can fall back to `say` rather than failing the action outright —
 * hearing the alert in the wrong voice beats not hearing it.
 */
export function playAudioBase64(audioBase64: string): boolean {
  let dir: string | undefined;
  let file: string | undefined;
  try {
    const buf = Buffer.from(audioBase64, "base64");
    if (buf.length === 0) return false;
    dir = mkdtempSync(join(tmpdir(), "maisie-speak-"));
    file = join(dir, `alert.${extensionFor(buf)}`);
    writeFileSync(file, buf);
    // afplay blocks until the clip finishes, which is what we want — the action
    // is not "applied" until Jack has actually heard it.
    execFileSync("/usr/bin/afplay", [file], { timeout: PLAYBACK_TIMEOUT_MS });
    return true;
  } catch (err) {
    console.error("[speak] afplay failed:", err instanceof Error ? err.message : err);
    return false;
  } finally {
    if (file) { try { unlinkSync(file); } catch { /* ignore */ } }
  }
}

/** Fallback: the built-in macOS voice. */
export function sayText(text: string): boolean {
  try {
    execFileSync("/usr/bin/say", [text], { timeout: PLAYBACK_TIMEOUT_MS });
    return true;
  } catch (err) {
    console.error("[speak] say failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Speak an alert, preferring the supplied audio and degrading to `say`.
 * Returns which path actually produced sound.
 */
export function speak(
  text: string,
  audioBase64?: string | null
): { spoken: boolean; via: "elevenlabs" | "say" | "none" } {
  if (audioBase64 && playAudioBase64(audioBase64)) {
    return { spoken: true, via: "elevenlabs" };
  }
  if (text && sayText(text)) return { spoken: true, via: "say" };
  return { spoken: false, via: "none" };
}
