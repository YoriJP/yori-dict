import { expect, test } from "bun:test";
import { deinflect } from "../src/deinflect";

test("deinflects common ichidan polite forms", () => {
  expect(deinflect("食べました").map((candidate) => candidate.text)).toContain("食べる");
});

test("deinflects i-adjective past forms", () => {
  expect(deinflect("かわいかった").map((candidate) => candidate.text)).toContain("かわいい");
});
