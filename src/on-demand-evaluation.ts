import { onDemandEvaluationContracts, reviewOutcome, type ModelGateway } from "./on-demand-dictionary";

type Candidate = { id: string; candidate: unknown };

export type ReviewCase = Candidate & {
  kind: "entry" | "example";
  expected: "accepted" | "rejected";
};

export type ReviewCorpus = {
  reviewDefects: Candidate[];
  entryReviews?: Array<Candidate & { expected: ReviewCase["expected"] }>;
  acceptedExamples: Candidate[];
  rejectedExamples: Candidate[];
};

export function reviewCases(corpus: ReviewCorpus): ReviewCase[] {
  return [
    ...corpus.reviewDefects.map((test) => ({ ...test, kind: "entry" as const, expected: "rejected" as const })),
    ...(corpus.entryReviews ?? []).map((test) => ({ ...test, kind: "entry" as const })),
    ...corpus.acceptedExamples.map((test) => ({ ...test, kind: "example" as const, expected: "accepted" as const })),
    ...corpus.rejectedExamples.map((test) => ({ ...test, kind: "example" as const, expected: "rejected" as const }))
  ];
}

export async function evaluateReview(test: ReviewCase, gateway: ModelGateway): Promise<ReturnType<typeof reviewOutcome>> {
  // Defect names and expected verdicts must not reach the reviewer.
  const candidateId = `eval:${crypto.randomUUID()}`;
  const requests = test.kind === "entry"
    ? onDemandEvaluationContracts.entryReview(candidateId, test.candidate)
    : onDemandEvaluationContracts.exampleReview(candidateId, test.candidate);
  for (const request of requests) {
    const response = await gateway.call({
      ...request,
      requestedServiceTier: "standard",
      signal: AbortSignal.timeout(120_000)
    });
    const outcome = reviewOutcome(response.text);
    if (outcome !== "accepted") return outcome;
  }
  return "accepted";
}
