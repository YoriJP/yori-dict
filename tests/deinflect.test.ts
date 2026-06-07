import { expect, test } from "bun:test";
import { deinflect } from "../src/deinflect";

test("deinflects common ichidan polite forms", () => {
  expect(deinflect("食べました").map((candidate) => candidate.text)).toContain("食べる");
});

test("deinflects godan past forms", () => {
  expect(deinflect("読んだ").map((candidate) => candidate.text)).toContain("読む");
});

test("deinflects godan negative past forms", () => {
  expect(deinflect("行かなかった").map((candidate) => candidate.text)).toContain("行く");
});

test("deinflects godan polite negative forms", () => {
  expect(deinflect("読みません").map((candidate) => candidate.text)).toContain("読む");
});

test("deinflects ichidan passive forms as lower-ranked candidates", () => {
  expect(deinflect("見せられた")).toContainEqual({
    text: "見せる",
    reasons: ["ichidan passive past"]
  });
});

test("deinflects i-adjective past forms", () => {
  expect(deinflect("かわいかった").map((candidate) => candidate.text)).toContain("かわいい");
});

test("deinflects i-adjective negative forms", () => {
  expect(deinflect("高くない").map((candidate) => candidate.text)).toContain("高い");
});
