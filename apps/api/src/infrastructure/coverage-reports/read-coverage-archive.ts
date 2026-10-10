import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import type { CoverageFormat, CoverageReport } from "@dora-dashboard/core";
import type { ArtefactContents } from "../../interfaces/coverage-source.js";
import { UpstreamError } from "../../core/errors.js";
import { parseCobertura } from "./parse-cobertura.js";
import { parseIstanbulFinal, parseIstanbulSummary } from "./parse-istanbul.js";
import { parseLcov } from "./parse-lcov.js";
import { yieldToEventLoop } from "./yield-loop.js";

// The caps below bound what one artefact can cost in time and memory. The reasoning is in ADR 0030:
// docs/architecture/decisions/0030-read-measured-coverage-from-ci-artefacts-for-display-only.md

/** The most entries looked at in one archive, wanted or not, so a zip of a million empty files costs little. */
export const MAX_ENTRIES_SCANNED = 5_000;
/** The most one coverage file may declare it unzips to. A real report is a few megabytes. */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/**
 * The most one XML (Cobertura) file may unzip to. The XML parser builds a tree several times the size of its input, so
 * it gets half the allowance of the flat formats; a real Cobertura report is a few megabytes.
 */
export const MAX_XML_ENTRY_BYTES = 32 * 1024 * 1024;
/** The most all the coverage files together may declare, which bounds the memory one artefact can take. */
export const MAX_TOTAL_BYTES = 192 * 1024 * 1024;

/** How far into an XML file to look for the root element's attributes. */
const SNIFF_CHARS = 4_096;

/**
 * How much of the archive is handed to the unzipper at once. Deflate expands at most about a thousandfold, so one chunk
 * cannot inflate past roughly 16 MiB before the counts are checked.
 */
const FEED_CHUNK_BYTES = 16 * 1024;
/** How many chunks are fed between yields to the event loop. */
const YIELD_EVERY_CHUNKS = 16;

/** True when the bytes open with a zip entry (or an empty archive) and close with an end-of-central-directory record. */
function looksLikeWholeZip(bytes: Uint8Array): boolean {
  if (bytes.length < 22) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const first = view.getUint32(0, true);
  if (first !== 0x04034b50 && first !== 0x06054b50) return false;
  // The record is 22 bytes plus a comment of at most 65535 bytes, so it starts within that distance of the end.
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= lowest; at--) if (view.getUint32(at, true) === 0x06054b50) return true;
  return false;
}

const wrongSize = () => new UpstreamError("A file in the coverage artefact is not the size it declares", 502);
const overCap = (what: string) => new UpstreamError(`The coverage artefact is over the limit on ${what}`, 502);

/** The format a file is read as, chosen by its base name alone, or null when it is not a coverage file we read. */
function formatOf(name: string): CoverageFormat | "xml" | null {
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  if (base === "lcov.info" || base.endsWith(".lcov")) return "lcov";
  if (base === "coverage-final.json") return "istanbul-final";
  if (base === "coverage-summary.json") return "istanbul-summary";
  if (base.endsWith(".xml") && (base === "coverage.xml" || base.includes("cobertura"))) return "xml";
  return null;
}

/** The directory of an entry with empty and parent segments dropped, as a hint and never as a path to open. */
const directoryOf = (name: string): string =>
  name
    .split("/")
    .slice(0, -1)
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
    .join("/");

/** Cobertura says `line-rate=` on its root, where Clover says `clover=`, and the two share the name `coverage.xml`. */
const looksLikeCobertura = (text: string): boolean => {
  const head = text.slice(0, SNIFF_CHARS);
  return head.includes("line-rate=") && !head.includes("clover=");
};

/**
 * Unzips a downloaded coverage artefact and parses every coverage file in it that this reader knows: lcov, Istanbul
 * `coverage-final.json` and `coverage-summary.json`, and Cobertura XML. Files are chosen by base name, so nothing else
 * in the archive is inflated. Other coverage formats (JaCoCo, Clover, Go profiles) are left out.
 *
 * Archives come from CI and are not trusted. The archive is fed to a streaming reader in small chunks, with a yield to
 * the event loop between groups of chunks. What is checked, and when:
 *
 * - The entries scanned, the size each wanted file declares and the total declared are capped. The entry count and each
 *   declared size are checked as the entry's header arrives, before that file is inflated, and an XML file has a lower
 *   cap than the others.
 * - The bytes each wanted file really produces are counted. The count must never pass the size the entry declares, and
 *   when the entry ends it must equal a declared size that is not zero. Either mismatch is refused, so a truncated
 *   file is never read as if it were whole.
 * - The archive must open with an entry and end with its central directory record, so one cut short is refused.
 * - An entry that declares no size (a streamed archive) is held to the per-file and total caps by the bytes produced.
 *
 * A failure of the archive itself is an `UpstreamError` that names no path from inside it. A coverage file that cannot
 * be parsed costs only itself: it is counted in `unreadable` with a message fit to show, and a file that lists no file
 * is counted in `empty`, so the other files in the artefact are still read.
 */
export async function readCoverageArchive(bytes: Uint8Array, artefact: string): Promise<ArtefactContents> {
  const kinds = new Map<string, CoverageFormat | "xml">();
  const files = new Map<string, Uint8Array>();
  let scanned = 0;
  let declared = 0;
  let produced = 0;
  let open = 0;

  const unzip = new Unzip((file) => {
    if (++scanned > MAX_ENTRIES_SCANNED) throw overCap("entries");
    const kind = file.name.endsWith("/") ? null : formatOf(file.name);
    if (!kind) return;
    const limit = kind === "xml" ? MAX_XML_ENTRY_BYTES : MAX_ENTRY_BYTES;
    const size = file.originalSize;
    if (size !== undefined) {
      if (size > limit) throw overCap("the size of one file");
      declared += size;
      if (declared > MAX_TOTAL_BYTES) throw overCap("the total size");
    }
    const chunks: Uint8Array[] = [];
    let count = 0;
    open++;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      count += chunk.length;
      produced += chunk.length;
      if (count > limit) throw overCap("the size of one file");
      if (produced > MAX_TOTAL_BYTES) throw overCap("the total size");
      if (size !== undefined && count > size) throw wrongSize();
      chunks.push(chunk);
      if (!final) return;
      if (size !== undefined && size > 0 && count !== size) throw wrongSize();
      const whole = new Uint8Array(count);
      let at = 0;
      for (const part of chunks) {
        whole.set(part, at);
        at += part.length;
      }
      chunks.length = 0;
      kinds.set(file.name, kind);
      files.set(file.name, whole);
      open--;
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);

  try {
    if (!looksLikeWholeZip(bytes)) throw new Error("not a zip");
    let chunksPushed = 0;
    for (let at = 0; at < bytes.length || at === 0; at += FEED_CHUNK_BYTES) {
      const end = Math.min(at + FEED_CHUNK_BYTES, bytes.length);
      unzip.push(bytes.subarray(at, end), end >= bytes.length);
      if (++chunksPushed % YIELD_EVERY_CHUNKS === 0) await yieldToEventLoop();
      if (end >= bytes.length) break;
    }
    if (open > 0) throw new Error("incomplete");
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError("The coverage artefact is not a readable zip archive", 502, { cause: error });
  }

  const decoder = new TextDecoder();
  const reports: CoverageReport[] = [];
  const unreadable: string[] = [];
  let empty = 0;
  for (const name of [...files.keys()].sort()) {
    const text = decoder.decode(files.get(name));
    files.delete(name);
    const dir = directoryOf(name);
    const kind = kinds.get(name)!;
    try {
      let report: CoverageReport | null = null;
      if (kind === "lcov") report = { format: kind, artefact, dir, files: await parseLcov(text) };
      else if (kind === "istanbul-final") report = { format: kind, artefact, dir, files: await parseIstanbulFinal(text) };
      else if (kind === "istanbul-summary") report = { format: kind, artefact, dir, files: await parseIstanbulSummary(text) };
      else if (kind === "xml" && looksLikeCobertura(text)) {
        const parsed = await parseCobertura(text);
        report = {
          format: "cobertura",
          artefact,
          dir,
          ...(parsed.sourceRoots.length > 0 ? { sourceRoots: parsed.sourceRoots } : {}),
          files: parsed.files,
        };
      }
      if (report && report.files.length > 0) reports.push(report);
      else if (report) empty++;
    } catch (error) {
      unreadable.push(error instanceof UpstreamError ? error.message : "A coverage file in the artefact could not be read");
    }
    await yieldToEventLoop();
  }
  return { reports, unreadable, empty };
}
