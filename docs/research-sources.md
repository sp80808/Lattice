# External research sources

Lattice treats external retrieval as **provenance-bearing evidence**, not as automatically verified truth.

The first research package normalizes multiple public scholarly indexes into one record shape and can emit compact TAP `external` evidence refs. Those refs are deliberately marked `verified: false`: retrieval verifies that a source returned a record, not that every claim in the record is correct.

## Initial source set

| Source | Auth | Best use |
| --- | --- | --- |
| arXiv | none | current preprints, especially CS/ML |
| Crossref | none; `mailto` recommended | DOI metadata and publication lookup |
| OpenAlex | light/keyless demo use; free key recommended | broad scholarly graph, citations, OA metadata |
| Europe PMC | none | biomedical papers, preprints, citations, OA links |
| Semantic Scholar | optional/API key depending use | academic graph, citations, OA metadata |

Environment variables used by the CLI:

- `LATTICE_RESEARCH_MAILTO`
- `LATTICE_OPENALEX_API_KEY`
- `LATTICE_SEMANTIC_SCHOLAR_API_KEY`

Examples:

```bash
lattice research "uncertainty-aware tool routing for LLM agents" --limit 8
lattice research "MCP tool retrieval" --source arxiv,openalex --json
```

## Dedupe and provenance

Records are deduplicated in this order:

1. DOI;
2. stable scholarly IDs (arXiv, PMID/PMCID, OpenAlex, Semantic Scholar);
3. canonical URL;
4. normalized title + year.

When records merge, every contributing source remains in `provenance`. The federation prefers a longer abstract and the highest observed citation count but does not discard the source path.

## Failure model

Source failures are isolated by default. A rate limit or outage should not make repository/test evidence unusable. Every source returns an explicit status so routing and replay can distinguish "no results" from "source unavailable".

## Next slices

- #29: public OAuth/device flow for Hugging Face and GitHub.
- #31: source-capability routing, uncertainty triggers and proof-of-use.
- #32: make research probes a first-class Lattice experiment and benchmark routed retrieval against naive fan-out.

The long-term rule is: **retrieve narrowly, preserve provenance, show conflicts, and measure whether the evidence was actually used.**
