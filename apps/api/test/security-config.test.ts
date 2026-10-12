import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";

describe("the security lookups in the config", () => {
  it("leaves both lookups off, and no private scopes, unless they are set", () => {
    expect(loadConfig({})).toMatchObject({ osvLookup: false, osvPrivateNpmScopes: [], scorecardLookup: false });
  });

  it.each([
    ["on", true],
    ["ON", true],
    [" On ", true],
    ["off", false],
    ["", false],
    ["true", false],
    ["1", false],
    ["yes", false],
  ])("reads OSV_LOOKUP=%j as %s, and SCORECARD_LOOKUP alike", (value, expected) => {
    expect(loadConfig({ OSV_LOOKUP: value }).osvLookup).toBe(expected);
    expect(loadConfig({ SCORECARD_LOOKUP: value }).scorecardLookup).toBe(expected);
  });

  it("reads the private npm scopes as a trimmed list with the blanks left out", () => {
    expect(loadConfig({ OSV_PRIVATE_NPM_SCOPES: " @acme, @acme-labs ,,@widgets " }).osvPrivateNpmScopes).toEqual([
      "@acme",
      "@acme-labs",
      "@widgets",
    ]);
    expect(loadConfig({ OSV_PRIVATE_NPM_SCOPES: " , " }).osvPrivateNpmScopes).toEqual([]);
  });

  it("refuses to start with the OSV lookup on and code analysis off, and says what to change", () => {
    expect(() => loadConfig({ OSV_LOOKUP: "on", CODE_ANALYSIS: "off" })).toThrow("OSV_LOOKUP=on needs code analysis");
    expect(() => loadConfig({ OSV_LOOKUP: "on", CODE_ANALYSIS: "OFF" })).toThrow("CODE_ANALYSIS=on");
  });

  it("starts with the OSV lookup on when code analysis is on, by default or by choice, and with code analysis off while OSV is off", () => {
    expect(loadConfig({ OSV_LOOKUP: "on" }).osvLookup).toBe(true);
    expect(loadConfig({ OSV_LOOKUP: "on", CODE_ANALYSIS: "on" }).osvLookup).toBe(true);
    expect(loadConfig({ CODE_ANALYSIS: "off" })).toMatchObject({ codeAnalysis: false, osvLookup: false });
    // The scorecard lookup does not need the clone.
    expect(loadConfig({ SCORECARD_LOOKUP: "on", CODE_ANALYSIS: "off" })).toMatchObject({
      scorecardLookup: true,
      codeAnalysis: false,
    });
  });
});
