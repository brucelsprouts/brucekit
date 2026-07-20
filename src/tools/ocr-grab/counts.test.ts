import { describe, expect, it } from "vitest";
import { countLines, countWords } from "./OcrPanel";

describe("countWords", () => {
  it("counts whitespace-separated runs", () => {
    expect(countWords("hello world")).toBe(2);
    expect(countWords("one")).toBe(1);
  });

  it("does not let OCR's ragged whitespace inflate the count", () => {
    // Recognized text routinely arrives with double spaces and trailing
    // newlines; naive split(" ") would report empties as words.
    expect(countWords("  hello   world  \n")).toBe(2);
    expect(countWords("a\n\nb\tc")).toBe(3);
  });

  it("treats blank input as zero, not one", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n  ")).toBe(0);
  });
});

describe("countLines", () => {
  it("counts lines and tolerates CRLF", () => {
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("a\r\nb")).toBe(2);
    expect(countLines("single")).toBe(1);
  });

  it("ignores the trailing newline OCR usually appends", () => {
    expect(countLines("a\nb\n")).toBe(2);
  });

  it("treats blank input as zero, not one", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("  \n ")).toBe(0);
  });
});
