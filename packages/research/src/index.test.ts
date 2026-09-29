import assert from "node:assert/strict";
import test from "node:test";
import {
  CrossrefSource,
  OpenAlexSource,
  ResearchFederation,
  researchRecordsToEvidence,
  type ResearchRecord,
  type ResearchSourceAdapter,
} from "./index.js";

function jsonFetch(payload: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

test("Crossref normalizes DOI metadata", async () => {
  const source = new CrossrefSource({
    fetch: jsonFetch({
      message: {
        items: [
          {
            DOI: "10.1000/XYZ",
            title: ["A Useful Paper"],
            author: [{ given: "Ada", family: "Lovelace" }],
            issued: { "date-parts": [[2026, 1, 2]] },
            URL: "https://doi.org/10.1000/XYZ",
            abstract: "<jats:p>Evidence first.</jats:p>",
            "is-referenced-by-count": 12,
          },
        ],
      },
    }),
  });

  const records = await source.search({ text: "useful", limit: 3 });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.doi, "10.1000/xyz");
  assert.deepEqual(records[0]!.authors, ["Ada Lovelace"]);
  assert.equal(records[0]!.year, 2026);
  assert.equal(records[0]!.abstract, "Evidence first.");
});

test("OpenAlex reconstructs inverted abstracts", async () => {
  const source = new OpenAlexSource({
    fetch: jsonFetch({
      results: [
        {
          id: "https://openalex.org/W1",
          doi: "https://doi.org/10.1000/test",
          title: "Grounded agents",
          authorships: [
            { author: { display_name: "Researcher One" } },
          ],
          publication_year: 2025,
          publication_date: "2025-04-01",
          cited_by_count: 7,
          open_access: { is_oa: true },
          primary_location: {
            landing_page_url: "https://example.test/paper",
          },
          abstract_inverted_index: {
            agents: [1],
            Grounded: [0],
            verify: [2],
            evidence: [3],
          },
        },
      ],
    }),
  });

  const records = await source.search({ text: "grounded" });
  assert.equal(records[0]!.abstract, "Grounded agents verify evidence");
  assert.equal(records[0]!.openAccess, true);
});

test("federation dedupes DOI matches and preserves provenance", async () => {
  const base: ResearchRecord = {
    id: "crossref:10.1/x",
    source: "crossref",
    title: "Same work",
    url: "https://doi.org/10.1/x",
    doi: "10.1/x",
    externalIds: { doi: "10.1/x" },
    authors: ["A"],
    year: 2025,
    abstract: "short",
    citationCount: 2,
    retrievedAt: "2026-09-29T00:00:00.000Z",
    provenance: [
      {
        source: "crossref",
        sourceId: "10.1/x",
        url: "https://doi.org/10.1/x",
      },
    ],
  };

  const first: ResearchSourceAdapter = {
    capabilities: {
      id: "crossref",
      domains: ["papers"],
      auth: "none",
      supports: ["search"],
    },
    async search() {
      return [base];
    },
  };

  const second: ResearchSourceAdapter = {
    capabilities: {
      id: "openalex",
      domains: ["papers"],
      auth: "optional-api-key",
      supports: ["search"],
    },
    async search() {
      return [
        {
          ...base,
          id: "openalex:W1",
          source: "openalex",
          abstract: "a much longer abstract from another index",
          citationCount: 8,
          provenance: [
            {
              source: "openalex",
              sourceId: "W1",
              url: "https://openalex.org/W1",
            },
          ],
        },
      ];
    },
  };

  const result = await new ResearchFederation([first, second]).search(
    { text: "same work", limit: 5 },
    { parallelism: 2 },
  );

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]!.provenance.length, 2);
  assert.equal(result.records[0]!.citationCount, 8);
  assert.equal(
    result.records[0]!.abstract,
    "a much longer abstract from another index",
  );
});

test("federation degrades when one source fails", async () => {
  const good: ResearchSourceAdapter = {
    capabilities: {
      id: "crossref",
      domains: ["papers"],
      auth: "none",
      supports: ["search"],
    },
    async search() {
      return [];
    },
  };

  const bad: ResearchSourceAdapter = {
    capabilities: {
      id: "openalex",
      domains: ["papers"],
      auth: "optional-api-key",
      supports: ["search"],
    },
    async search() {
      throw new Error("rate limited");
    },
  };

  const result = await new ResearchFederation([good, bad]).search({
    text: "query",
  });

  assert.equal(result.sources.length, 2);
  assert.equal(
    result.sources.find((source) => source.source === "openalex")?.status,
    "error",
  );
});

test("research evidence is external and not automatically verified", () => {
  const evidence = researchRecordsToEvidence([
    {
      id: "crossref:10.1/x",
      source: "crossref",
      title: "Claim-bearing paper",
      doi: "10.1/x",
      externalIds: { doi: "10.1/x" },
      authors: ["A"],
      year: 2026,
      retrievedAt: "2026-09-29T00:00:00.000Z",
      provenance: [
        { source: "crossref", sourceId: "10.1/x" },
      ],
    },
  ]);

  assert.equal(evidence[0]!.kind, "external");
  assert.equal(evidence[0]!.verified, false);
  assert.match(evidence[0]!.source, /crossref/);
});
