import { Zip, ZipDeflate, strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { UpstreamError } from "../src/core/errors.js";
import {
  ARCHIVE_LIMITS,
  MAX_ENTRIES_SCANNED,
  MAX_ENTRY_BYTES,
  MAX_XML_ENTRY_BYTES,
  readCoverageArchive,
  type ArchiveLimits,
} from "../src/infrastructure/coverage-reports/read-coverage-archive.js";

const RUNNER = "/home/runner/work/widgets/widgets";
const LCOV = `SF:${RUNNER}/src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n`;
const FINAL = JSON.stringify({
  "src/b.ts": { path: "src/b.ts", statementMap: { "0": { start: { line: 1 } } }, s: { "0": 1 }, f: {}, b: {} },
});
const SUMMARY = JSON.stringify({ total: { lines: { total: 1, covered: 1 } }, "src/c.ts": { lines: { total: 1, covered: 1 } } });
const COBERTURA = `<coverage line-rate="0.5"><sources><source>${RUNNER}/packages/ui</source></sources><packages><package><classes>
<class filename="src/d.ts"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>`;

const zip = (entries: { [name: string]: string }) =>
  zipSync(Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, strToU8(text)])));

/** Rewrites the uncompressed size that every entry declares, in the local headers and the central directory. */
function declareSize(bytes: Uint8Array, size: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  for (let i = 0; i + 30 <= copy.length; i++) {
    const signature = view.getUint32(i, true);
    if (signature === 0x04034b50) view.setUint32(i + 22, size, true);
    else if (signature === 0x02014b50) view.setUint32(i + 24, size, true);
  }
  return copy;
}

/** A zip written as a stream, so every entry follows its data with a descriptor and declares no size up front. */
function streamedZip(entries: { [name: string]: Uint8Array }): Uint8Array {
  const parts: Uint8Array[] = [];
  const zipper = new Zip((error, chunk) => {
    if (error) throw error;
    parts.push(chunk);
  });
  for (const [name, data] of Object.entries(entries)) {
    const file = new ZipDeflate(name);
    zipper.add(file);
    file.push(data, true);
  }
  zipper.end();
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("readCoverageArchive", () => {
  it("reads every format by base name and records the directory of each file", async () => {
    const { reports } = await readCoverageArchive(
      zip({
        "coverage/lcov.info": LCOV,
        "ui/coverage-final.json": FINAL,
        "coverage-summary.json": SUMMARY,
        "reports/Cobertura-Report.xml": COBERTURA,
      }),
      "coverage-web",
    );

    expect(reports.map((r) => [r.format, r.dir, r.artefact])).toEqual([
      ["istanbul-summary", "", "coverage-web"],
      ["lcov", "coverage", "coverage-web"],
      ["cobertura", "reports", "coverage-web"],
      ["istanbul-final", "ui", "coverage-web"],
    ]);
    expect(reports[1]!.files[0]).toMatchObject({ path: `${RUNNER}/src/a.ts`, lines: { covered: 1, total: 2 } });
    expect(reports[2]!.sourceRoots).toEqual([`${RUNNER}/packages/ui`]);
    expect(reports[0]).not.toHaveProperty("sourceRoots");
  });

  it("accepts a .lcov file, coverage.xml and any letter case", async () => {
    const { reports } = await readCoverageArchive(zip({ "a/UNIT.LCOV": LCOV, "b/Coverage.xml": COBERTURA }), "coverage");

    expect(reports.map((r) => r.format)).toEqual(["lcov", "cobertura"]);
  });

  it("leaves out files by name that are not coverage, however they are nested", async () => {
    const { reports } = await readCoverageArchive(
      zip({
        "index.html": "<html/>",
        "node_modules/pkg/package.json": "{}",
        "coverage/lcov-report/base.css": "body{}",
        "coverage/clover.xml": COBERTURA,
        "jacoco.xml": COBERTURA,
        "coverage/coverage.out": "mode: set",
        "coverage/lcov.info.bak": LCOV,
      }),
      "coverage",
    );

    expect(reports).toEqual([]);
  });

  it("leaves out XML that is Clover or JaCoCo even when it is named coverage.xml", async () => {
    const clover = '<coverage generated="1" clover="4.4"><project timestamp="1"/></coverage>';
    const cloverWithRate = '<coverage line-rate="1" clover="4.4"/>';
    const jacoco = '<report name="widgets"><package name="a"/></report>';

    const contents = await readCoverageArchive(
      zip({ "a/coverage.xml": clover, "b/coverage.xml": cloverWithRate, "c/coverage.xml": jacoco }),
      "c",
    );

    expect(contents).toEqual({ reports: [], unreadable: [], empty: 0 });
  });

  it("counts a report that holds no files as empty, and fails nothing", async () => {
    const contents = await readCoverageArchive(zip({ "lcov.info": "", "coverage-final.json": "{}" }), "coverage");

    expect(contents).toEqual({ reports: [], unreadable: [], empty: 2 });
  });

  it("counts an empty lcov.info as empty and still reads the report beside it", async () => {
    const contents = await readCoverageArchive(zip({ "a/lcov.info": "", "b/lcov.info": LCOV }), "coverage");

    expect(contents.empty).toBe(1);
    expect(contents.unreadable).toEqual([]);
    expect(contents.reports.map((r) => r.dir)).toEqual(["b"]);
  });

  it("keeps the good report and counts one unreadable file when another file cannot be parsed", async () => {
    const contents = await readCoverageArchive(
      zip({ "secret-client/coverage-final.json": "<html>", "ui/lcov.info": LCOV }),
      "coverage",
    );

    expect(contents.reports.map((r) => r.format)).toEqual(["lcov"]);
    expect(contents.empty).toBe(0);
    expect(contents.unreadable).toEqual(["A coverage file in the artefact is not valid JSON of the expected shape"]);
    expect(contents.unreadable[0]).not.toContain("secret-client");
  });

  it("gives a generic message when a parser fails with something that is not an UpstreamError", async () => {
    vi.resetModules();
    vi.doMock("../src/infrastructure/coverage-reports/parse-lcov.js", () => ({
      parseLcov: () => Promise.reject(new TypeError("cannot read src/secret-client/a.ts")),
    }));
    try {
      const { readCoverageArchive: read } = await import("../src/infrastructure/coverage-reports/read-coverage-archive.js");

      const contents = await read(zip({ "lcov.info": LCOV }), "coverage");

      expect(contents).toEqual({ reports: [], unreadable: ["A coverage file in the artefact could not be read"], empty: 0 });
    } finally {
      vi.doUnmock("../src/infrastructure/coverage-reports/parse-lcov.js");
      vi.resetModules();
    }
  });

  it("counts a truncated Cobertura file as unreadable", async () => {
    const contents = await readCoverageArchive(zip({ "coverage.xml": COBERTURA.slice(0, 120) }), "coverage");

    expect(contents.reports).toEqual([]);
    expect(contents.unreadable).toEqual(["A coverage file in the artefact is not valid XML"]);
  });

  it("reads a Cobertura file with the document type declaration Istanbul writes", async () => {
    const header = '<?xml version="1.0" ?>\n<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">\n';

    const { reports, unreadable } = await readCoverageArchive(zip({ "coverage.xml": header + COBERTURA }), "coverage");

    expect(unreadable).toEqual([]);
    expect(reports.map((r) => r.format)).toEqual(["cobertura"]);
  });

  it("drops empty and parent segments from the directory hint", async () => {
    const {
      reports: [report],
    } = await readCoverageArchive(zip({ "../../etc//./lcov.info": LCOV }), "coverage");

    expect(report!.dir).toBe("etc");
  });

  it("answers an empty list for an empty archive", async () => {
    expect(await readCoverageArchive(zipSync({}), "coverage")).toEqual({ reports: [], unreadable: [], empty: 0 });
  });

  it("skips directory entries", async () => {
    const { reports } = await readCoverageArchive(
      zipSync({ "coverage/": new Uint8Array(0), "coverage/lcov.info": strToU8(LCOV) }),
      "c",
    );

    expect(reports).toHaveLength(1);
  });

  describe("refusals", () => {
    const refusal = async (bytes: Uint8Array, limits: ArchiveLimits = ARCHIVE_LIMITS) =>
      readCoverageArchive(bytes, "coverage", limits).catch((error: unknown) => error);

    /**
     * Caps small enough to cross with a few kilobytes. The rules do not depend on the size of a cap, and crossing the real
     * ones means inflating up to 192 MiB, which is slow enough on a shared CI runner to time out.
     */
    const SMALL: ArchiveLimits = { entries: 50, fileBytes: 8 * 1024, xmlFileBytes: 4 * 1024, totalBytes: 24 * 1024 };

    it("reads every artefact under the documented caps unless it is given others", () => {
      expect(ARCHIVE_LIMITS).toEqual({
        entries: 5_000,
        fileBytes: 64 * 1024 * 1024,
        xmlFileBytes: 32 * 1024 * 1024,
        totalBytes: 192 * 1024 * 1024,
      });
    });

    it("refuses bytes that are not a zip, without naming anything", async () => {
      const error = await refusal(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).message).toBe("The coverage artefact is not a readable zip archive");
    });

    it("refuses a zip cut short", async () => {
      const whole = zip({ "coverage/lcov.info": LCOV });

      expect(await refusal(whole.slice(0, whole.length - 10))).toBeInstanceOf(UpstreamError);
    });

    it("refuses a corrupt compressed stream", async () => {
      const bytes = zipSync({ "secret-client/lcov.info": [strToU8(LCOV.repeat(50)), { level: 9 }] });
      const view = new DataView(bytes.buffer);
      for (let i = 0; i + 30 <= bytes.length; i++) {
        if (view.getUint32(i, true) === 0x04034b50) {
          const start = i + 30 + view.getUint16(i + 26, true) + view.getUint16(i + 28, true);
          for (let j = start; j < start + 8; j++) bytes[j] = 0xff;
        }
      }

      const error = await refusal(bytes);

      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).message).not.toContain("secret-client");
    });

    it("refuses more entries than it will scan, wanted or not", async () => {
      const entries: { [name: string]: Uint8Array } = {};
      for (let i = 0; i <= MAX_ENTRIES_SCANNED; i++) entries[`f${i}.txt`] = new Uint8Array(0);

      const error = await refusal(zipSync(entries));

      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).message).toMatch(/entries/);
    });

    it("reads an archive of exactly the most entries, and refuses one more", async () => {
      const entries: { [name: string]: Uint8Array } = { "lcov.info": strToU8(LCOV) };
      for (let i = 1; i < SMALL.entries; i++) entries[`f${i}.txt`] = new Uint8Array(0);

      expect((await readCoverageArchive(zipSync(entries), "coverage", SMALL)).reports).toHaveLength(1);
      entries[`f${SMALL.entries}.txt`] = new Uint8Array(0);
      expect(((await refusal(zipSync(entries), SMALL)) as UpstreamError).message).toMatch(/entries/);
    });

    it("refuses a file that declares more than the per-file limit, before inflating it", async () => {
      const error = await refusal(declareSize(zip({ "evil/lcov.info": LCOV }), MAX_ENTRY_BYTES + 1));

      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).message).toMatch(/size of one file/);
      expect((error as UpstreamError).message).not.toContain("evil");
    });

    it("refuses a file that declares more than it holds, as it is cut short", async () => {
      const error = await refusal(declareSize(zip({ "evil/lcov.info": LCOV }), MAX_ENTRY_BYTES));

      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).message).toBe("A file in the coverage artefact is not the size it declares");
    });

    it("refuses files that together produce more than the total limit", async () => {
      // Three entries of one file's limit (8 KiB) fill the 24 KiB total exactly, so the one byte in the fourth crosses it.
      const third = new Uint8Array(SMALL.totalBytes / 3);
      const bytes = streamedZip({
        "a/lcov.info": third,
        "b/lcov.info": third,
        "c/lcov.info": third,
        "d/lcov.info": new Uint8Array(1),
      });

      const error = await refusal(bytes, SMALL);

      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).message).toMatch(/total size/);
    });

    it("reads files that together fill the total limit exactly", async () => {
      const third = new Uint8Array(SMALL.totalBytes / 3);
      const bytes = streamedZip({ "a/lcov.info": third, "b/lcov.info": third, "c/lcov.info": third });

      // Zeros are no report, so each counts as empty, but none is refused.
      expect(await readCoverageArchive(bytes, "coverage", SMALL)).toEqual({ reports: [], unreadable: [], empty: 3 });
    });

    it("refuses files that honestly declare more than the total limit together", async () => {
      // Four stored files of 8 KiB declare 32 KiB, over the 24 KiB total, before any is inflated.
      const real = new Uint8Array(SMALL.fileBytes);
      const bytes = zipSync({
        "a/lcov.info": [real, { level: 0 }],
        "b/lcov.info": [real, { level: 0 }],
        "c/lcov.info": [real, { level: 0 }],
        "d/lcov.info": [real, { level: 0 }],
      });

      const error = await refusal(bytes, SMALL);

      expect((error as UpstreamError).message).toMatch(/total size/);
    });

    it("refuses a file that declares less than it holds, as soon as the count passes the declared size", async () => {
      const text = `${LCOV}${"SF:src/z.ts\nDA:1,1\nend_of_record\n".repeat(1000)}`;

      const error = await refusal(declareSize(zip({ "evil/lcov.info": text }), LCOV.length));

      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).message).toBe("A file in the coverage artefact is not the size it declares");
      expect((error as UpstreamError).message).not.toContain("evil");
    });

    it("refuses a file that declares zero but holds data", async () => {
      expect(await refusal(declareSize(zip({ "lcov.info": LCOV }), 0))).toBeInstanceOf(UpstreamError);
    });

    it("refuses an XML file over the lower XML limit while a flat file of that size is allowed", async () => {
      const xml = await refusal(declareSize(zip({ "evil/coverage.xml": COBERTURA }), MAX_XML_ENTRY_BYTES + 1));
      const flat = await refusal(declareSize(zip({ "lcov.info": LCOV }), MAX_XML_ENTRY_BYTES + 1));

      expect(MAX_XML_ENTRY_BYTES).toBeLessThan(MAX_ENTRY_BYTES);
      expect((xml as UpstreamError).message).toMatch(/size of one file/);
      expect((flat as UpstreamError).message).toMatch(/not the size it declares/);
    });

    it("reads a streamed archive whose entries declare no size", async () => {
      const { reports } = await readCoverageArchive(
        streamedZip({ "a/lcov.info": strToU8(LCOV), "b/coverage.xml": strToU8(COBERTURA) }),
        "coverage",
      );

      expect(reports.map((r) => r.format)).toEqual(["lcov", "cobertura"]);
    });

    it("reads an archive larger than one feed chunk, yielding between chunks", async () => {
      const big = `${LCOV}${"SF:src/z.ts\nDA:1,1\nend_of_record\n".repeat(20_000)}`;
      const stored = zipSync({ "lcov.info": [strToU8(big), { level: 0 }] });
      expect(stored.length).toBeGreaterThan(16 * 16 * 1024);

      const {
        reports: [report],
      } = await readCoverageArchive(stored, "coverage");

      expect(report!.files.length).toBeGreaterThan(1);
    });

    it("stops a streamed entry that inflates past the per-file limit by the bytes it produces", async () => {
      const bomb = streamedZip({ "evil/coverage.xml": new Uint8Array(SMALL.xmlFileBytes + 1) });

      const error = await refusal(bomb, SMALL);

      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).message).toMatch(/size of one file/);
      expect((error as UpstreamError).message).not.toContain("evil");
    });

    it("lets a streamed flat file through at a size that would stop an XML file", async () => {
      // An empty report of 4 KiB + 1 is over the XML limit but under the 8 KiB limit for other files.
      const contents = await readCoverageArchive(
        streamedZip({ "lcov.info": new Uint8Array(SMALL.xmlFileBytes + 1) }),
        "coverage",
        SMALL,
      );

      expect(contents).toEqual({ reports: [], unreadable: [], empty: 1 });
    });

    it("keeps the reason on the error for a corrupt archive", async () => {
      const error = await refusal(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

      expect((error as UpstreamError).cause).toBeDefined();
    });
  });
});
