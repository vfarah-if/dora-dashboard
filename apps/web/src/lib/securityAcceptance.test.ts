import { describe, expect, it } from "vitest";
import { ACCEPTANCE_REASONS } from "@dora-dashboard/core";
import { ApiError } from "../api/client";
import { copy } from "../copy";
import { chainItem } from "../test/fixtures";
import {
  REASONS,
  acceptanceNote,
  acceptanceRequest,
  canAccept,
  conflictText,
  fullyAccepted,
  isLive,
  noteProblemText,
  reopenRule,
  statusSentence,
} from "./securityAcceptance";

const rules = copy.security.acceptance.section.reopen;
const w2 = "w2:0123456789abcdef";

describe("canAccept", () => {
  it("allows an item with a fingerprint and refuses one without, such as a key file whose blob id was not read", () => {
    expect(canAccept(chainItem("a.yml", 1, null, { fingerprint: w2 }))).toBe(true);
    expect(canAccept(chainItem("a.yml", 1))).toBe(false);
  });
});

describe("the reasons", () => {
  it("are core's four, in core's order", () => {
    expect(REASONS).toEqual(["false_positive", "guarded_elsewhere", "public_by_design", "risk_accepted"]);
    expect(REASONS).toEqual(ACCEPTANCE_REASONS);
  });

  it("each have a label and a hint", () => {
    for (const reason of REASONS) {
      expect(copy.security.acceptance.reasons[reason].label.length).toBeGreaterThan(3);
      expect(copy.security.acceptance.reasons[reason].hint.length).toBeGreaterThan(20);
    }
  });
});

describe("acceptanceNote", () => {
  it("names the band before when acceptance changed it, in the singular", () => {
    expect(acceptanceNote("high", "low", 1)).toBe("Low before 1 accepted finding");
  });

  it("names the band before in the plural", () => {
    expect(acceptanceNote("elite", "medium", 3)).toBe("Medium before 3 accepted findings");
  });

  it("says the band is the same when findings are accepted and the band did not move", () => {
    expect(acceptanceNote("low", "low", 2)).toBe("The band is the same with or without 2 accepted findings");
    expect(acceptanceNote("low", "low", 1)).toBe("The band is the same with or without 1 accepted finding");
  });

  it.each([
    ["no band", null, "low", 1],
    ["nothing matched, so no band before", "high", null, 1],
    ["only advice accepted, which the grade never counted", "high", "high", 0],
  ] as const)("says nothing with %s", (_name, band, before, graded) => {
    expect(acceptanceNote(band, before, graded)).toBeNull();
  });
});

describe("reopenRule", () => {
  it.each([
    [w2, rules.w2, "a caller that reaches it or a condition on the way"],
    ["a1:0123456789abcdef", rules.a1, "the reference of the action"],
    [`b:${"a".repeat(40)}`, rules.b, "the file changes"],
    ["p1:", rules.p1, "a lockfile appears"],
    ["n1:", rules.n1, "the file or the tool appears"],
  ])("says when %s stops holding", (fingerprint, rule, words) => {
    expect(reopenRule(fingerprint)).toBe(rule);
    expect(rule).toContain(words);
  });

  it("falls back to the general rule for a retired prefix, an unknown one and one with no colon", () => {
    const other = copy.security.acceptance.section.reopenOther;
    expect(reopenRule("w1:0123456789abcdef")).toBe(other);
    expect(reopenRule("z9:abc")).toBe(other);
    expect(reopenRule("reopenOther:abc")).toBe(other);
    expect(reopenRule("no colon")).toBe(other);
  });
});

describe("the status of an acceptance", () => {
  it("is live when it applies or has not been checked yet, and has lapsed when it is reopened or gone", () => {
    expect(isLive({ status: "applies" })).toBe(true);
    expect(isLive({ status: "unchecked" })).toBe(true);
    for (const status of ["reopened", "gone"] as const) expect(isLive({ status })).toBe(false);
  });

  it("says a reopened one no longer applies, a gone one matches nothing in the latest read, and an unchecked one waits for the crawl", () => {
    expect(statusSentence({ status: "reopened" })).toMatch(/no longer applies/);
    expect(statusSentence({ status: "reopened" })).toMatch(/in this file is open again/);
    expect(statusSentence({ status: "gone" })).toMatch(/no longer matches anything the latest read reports/);
    expect(statusSentence({ status: "gone" })).not.toMatch(/no longer there/);
    expect(statusSentence({ status: "unchecked" })).toMatch(/latest read could not check it/);
    expect(statusSentence({ status: "unchecked" })).toMatch(/checked again at the next crawl/);
    expect(statusSentence({ status: "unchecked" })).not.toMatch(/remove/i);
    expect(statusSentence({ status: "applies" })).toBe("It applies now.");
  });
});

describe("conflictText", () => {
  it.each([
    ["acceptance_no_record", copy.security.acceptance.conflicts.acceptance_no_record],
    ["acceptance_finding_changed", copy.security.acceptance.conflicts.acceptance_finding_changed],
    ["acceptance_duplicate", copy.security.acceptance.conflicts.acceptance_duplicate],
    ["acceptance_limit", copy.security.acceptance.conflicts.acceptance_limit],
  ] as const)("gives a 409 coded %s its own sentence", (code, sentence) => {
    expect(conflictText(new ApiError(409, "Server wording.", code))).toBe(sentence);
  });

  it("gives a 409 with no code, or one this build does not know, the general sentence", () => {
    expect(conflictText(new ApiError(409, "Conflict."))).toBe(copy.security.acceptance.changed);
    expect(conflictText(new ApiError(409, "Conflict.", "jira_unauthorised"))).toBe(copy.security.acceptance.changed);
  });

  it("gives nothing for any other failure", () => {
    expect(conflictText(new ApiError(429, "Slow down."))).toBeNull();
    expect(conflictText(new Error("boom"))).toBeNull();
  });
});

describe("noteProblemText", () => {
  it("words each problem, with the limit from core", () => {
    expect(noteProblemText("empty")).toBe(copy.security.acceptance.problems.empty);
    expect(noteProblemText("control")).toBe(copy.security.acceptance.problems.control);
    expect(noteProblemText("tooLong")).toBe("The note must hold at most 280 characters.");
  });
});

describe("acceptanceRequest", () => {
  it("holds exactly the five fields the API takes, with the note trimmed", () => {
    const body = acceptanceRequest(
      { check: "keyFiles", path: ".env.production", fingerprint: `b:${"a".repeat(40)}` },
      "public_by_design",
      "  An example file.  ",
    );
    expect(body).toEqual({
      check: "keyFiles",
      path: ".env.production",
      fingerprint: `b:${"a".repeat(40)}`,
      reason: "public_by_design",
      note: "An example file.",
    });
    expect(Object.keys(body).sort()).toEqual(["check", "fingerprint", "note", "path", "reason"]);
  });

  it("sends a null path for an absence", () => {
    expect(acceptanceRequest({ check: "securityPolicy", path: null, fingerprint: "n1:" }, "risk_accepted", "x").path).toBeNull();
  });
});

describe("fullyAccepted", () => {
  it("is true only when something was accepted and nothing open is left", () => {
    expect(fullyAccepted({ accepted: 1, total: 0, absence: null })).toBe(true);
    expect(fullyAccepted({ accepted: 0, total: 0, absence: null })).toBe(false);
    expect(fullyAccepted({ accepted: 1, total: 2, absence: null })).toBe(false);
    expect(fullyAccepted({ accepted: 1, total: 0, absence: { fingerprint: "n1:" } })).toBe(false);
  });
});
