import { createHash } from "node:crypto";
import type { EvidenceRef } from "@lattice/protocol";

export type ResearchSourceId =
  | "arxiv"
  | "crossref"
  | "openalex"
  | "europe-pmc"
  | "semantic-scholar";

export type ResearchAuthMode =
  | "none"
  | "optional-api-key"
  | "api-key"
  | "oauth-public-client";

export interface ResearchSourceCapabilities {
  id: ResearchSourceId;
  domains: string[];
  auth: ResearchAuthMode;
  supports: Array<
    "search" | "lookup" | "citations" | "open-access" | "full-text-links"
  >;
  notes?: string;
}

export interface ResearchQuery {
  text: string;
  limit?: number;
  sinceYear?: number;
  openAccessOnly?: boolean;
}

export interface ResearchProvenance {
  source: ResearchSourceId;
  sourceId: string;
  url?: string;
}

export interface ResearchRecord {
  id: string;
  source: ResearchSourceId;
  title: string;
  url?: string;
  doi?: string;
  externalIds: Record<string, string>;
  authors: string[];
  year?: number;
  publishedAt?: string;
  abstract?: string;
  citationCount?: number;
  openAccess?: boolean;
  retrievedAt: string;
  provenance: ResearchProvenance[];
}

export interface ResearchSourceAdapter {
  readonly capabilities: ResearchSourceCapabilities;
  search(query: ResearchQuery): Promise<ResearchRecord[]>;
}

export interface ResearchSourceStatus {
  source: ResearchSourceId;
  status: "ok" | "error";
  count: number;
  durationMs: number;
  error?: string;
}

export interface ResearchFederationResult {
  query: ResearchQuery;
  records: ResearchRecord[];
  sources: ResearchSourceStatus[];
}

export interface ResearchFederationOptions {
  parallelism?: number;
  failFast?: boolean;
  maxResults?: number;
}

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

interface AdapterHttpOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(Math.floor(value), 50));
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

function normalizeDoi(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
  return normalized || undefined;
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function makeRecordId(source: ResearchSourceId, sourceId: string): string {
  return source + ":" + sourceId;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function authorNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const raw of value) {
    const item = asObject(raw);
    if (!item) continue;
    const direct = asString(item.name) ?? asString(item.display_name);
    if (direct) {
      names.push(direct);
      continue;
    }
    const given = asString(item.given);
    const family = asString(item.family);
    const combined = [given, family].filter(Boolean).join(" ").trim();
    if (combined) names.push(combined);
  }
  return names;
}

async function fetchResponse(
  fetcher: FetchLike,
  url: URL,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetcher(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      url.hostname +
        " returned HTTP " +
        response.status +
        (response.statusText ? " " + response.statusText : ""),
    );
  }
  return response;
}

async function fetchJson(
  fetcher: FetchLike,
  url: URL,
  timeoutMs: number,
  init?: RequestInit,
): Promise<unknown> {
  return (await fetchResponse(fetcher, url, timeoutMs, init)).json();
}

function dedupeKey(record: ResearchRecord): string {
  if (record.doi) return "doi:" + record.doi;

  for (const key of ["arxiv", "pmid", "pmcid", "openalex", "s2"]) {
    const value = record.externalIds[key];
    if (value) return key + ":" + value.toLowerCase();
  }

  if (record.url) return "url:" + record.url.toLowerCase();
  return "title:" + normalizeTitle(record.title) + ":" + (record.year ?? "unknown");
}

function mergeRecords(
  current: ResearchRecord,
  incoming: ResearchRecord,
): ResearchRecord {
  const abstract =
    (incoming.abstract?.length ?? 0) > (current.abstract?.length ?? 0)
      ? incoming.abstract
      : current.abstract;

  const citationCount =
    current.citationCount === undefined
      ? incoming.citationCount
      : incoming.citationCount === undefined
        ? current.citationCount
        : Math.max(current.citationCount, incoming.citationCount);

  return {
    ...current,
    url: current.url ?? incoming.url,
    doi: current.doi ?? incoming.doi,
    externalIds: { ...incoming.externalIds, ...current.externalIds },
    authors:
      current.authors.length >= incoming.authors.length
        ? current.authors
        : incoming.authors,
    year: current.year ?? incoming.year,
    publishedAt: current.publishedAt ?? incoming.publishedAt,
    abstract,
    citationCount,
    openAccess:
      current.openAccess === true || incoming.openAccess === true
        ? true
        : current.openAccess ?? incoming.openAccess,
    provenance: [
      ...current.provenance,
      ...incoming.provenance.filter(
        (candidate) =>
          !current.provenance.some(
            (known) =>
              known.source === candidate.source &&
              known.sourceId === candidate.sourceId,
          ),
      ),
    ],
  };
}

function dedupeRecords(records: ResearchRecord[]): ResearchRecord[] {
  const byKey = new Map<string, ResearchRecord>();
  for (const record of records) {
    const key = dedupeKey(record);
    const current = byKey.get(key);
    byKey.set(key, current ? mergeRecords(current, record) : record);
  }
  return [...byKey.values()];
}

async function runLimited<T>(
  values: T[],
  limit: number,
  fn: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, values.length || 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      await fn(values[index]!);
    }
  });
  await Promise.all(workers);
}

export class ResearchFederation {
  constructor(private readonly adapters: ResearchSourceAdapter[]) {}

  get capabilities(): ResearchSourceCapabilities[] {
    return this.adapters.map((adapter) => adapter.capabilities);
  }

  async search(
    query: ResearchQuery,
    options: ResearchFederationOptions = {},
  ): Promise<ResearchFederationResult> {
    const text = query.text.trim();
    if (!text) throw new Error("Research query must not be empty");

    const normalizedQuery: ResearchQuery = {
      ...query,
      text,
      limit: boundedLimit(query.limit),
    };

    const statuses: ResearchSourceStatus[] = [];
    const collected: ResearchRecord[] = [];
    const parallelism = Math.max(
      1,
      Math.min(options.parallelism ?? 3, this.adapters.length || 1),
    );

    await runLimited(this.adapters, parallelism, async (adapter) => {
      const started = performance.now();
      try {
        const records = await adapter.search(normalizedQuery);
        collected.push(...records);
        statuses.push({
          source: adapter.capabilities.id,
          status: "ok",
          count: records.length,
          durationMs: performance.now() - started,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        statuses.push({
          source: adapter.capabilities.id,
          status: "error",
          count: 0,
          durationMs: performance.now() - started,
          error: message,
        });
        if (options.failFast) throw error;
      }
    });

    statuses.sort((a, b) => a.source.localeCompare(b.source));
    const records = dedupeRecords(collected).slice(
      0,
      options.maxResults ?? boundedLimit(query.limit),
    );

    return { query: normalizedQuery, records, sources: statuses };
  }
}

export function researchRecordToEvidence(
  record: ResearchRecord,
  maxSummaryChars = 900,
): EvidenceRef {
  const provenance = record.provenance
    .map((item) => item.source + ":" + item.sourceId)
    .join(",");

  const summary = [
    record.title,
    record.year ? "year=" + record.year : undefined,
    record.doi ? "doi=" + record.doi : undefined,
    record.authors.length
      ? "authors=" + record.authors.slice(0, 5).join(", ")
      : undefined,
    record.citationCount !== undefined
      ? "citations=" + record.citationCount
      : undefined,
    record.openAccess !== undefined
      ? "open_access=" + record.openAccess
      : undefined,
    record.abstract ? "abstract=" + record.abstract : undefined,
  ]
    .filter(Boolean)
    .join(" | ")
    .slice(0, maxSummaryChars);

  return {
    id:
      "ev:research:" +
      createHash("sha256").update(dedupeKey(record)).digest("hex").slice(0, 20),
    kind: "external",
    verified: false,
    source: "research:" + provenance,
    summary,
    createdAt: record.retrievedAt,
  };
}

export function researchRecordsToEvidence(
  records: ResearchRecord[],
  maxSummaryChars = 900,
): EvidenceRef[] {
  return records.map((record) =>
    researchRecordToEvidence(record, maxSummaryChars),
  );
}

function httpDefaults(options: AdapterHttpOptions): {
  fetcher: FetchLike;
  timeoutMs: number;
} {
  return {
    fetcher: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs ?? 12_000,
  };
}

export interface CrossrefOptions extends AdapterHttpOptions {
  mailto?: string;
}

export class CrossrefSource implements ResearchSourceAdapter {
  readonly capabilities: ResearchSourceCapabilities = {
    id: "crossref",
    domains: ["scholarly-metadata", "doi"],
    auth: "none",
    supports: ["search", "lookup", "citations"],
    notes: "Public REST API; mailto enables the polite pool.",
  };

  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: CrossrefOptions = {}) {
    ({ fetcher: this.fetcher, timeoutMs: this.timeoutMs } =
      httpDefaults(options));
  }

  async search(query: ResearchQuery): Promise<ResearchRecord[]> {
    const url = new URL("https://api.crossref.org/works");
    url.searchParams.set("query.bibliographic", query.text);
    url.searchParams.set("rows", String(boundedLimit(query.limit)));
    if (this.options.mailto) url.searchParams.set("mailto", this.options.mailto);
    if (query.sinceYear) {
      url.searchParams.set(
        "filter",
        "from-pub-date:" + query.sinceYear + "-01-01",
      );
    }

    const root = asObject(await fetchJson(this.fetcher, url, this.timeoutMs));
    const message = asObject(root?.message);
    const items = Array.isArray(message?.items) ? message.items : [];
    const retrievedAt = nowIso();

    return items.flatMap((raw): ResearchRecord[] => {
      const item = asObject(raw);
      if (!item) return [];

      const doi = normalizeDoi(item.DOI);
      const title =
        Array.isArray(item.title) && item.title.length
          ? asString(item.title[0])
          : asString(item.title);
      if (!title) return [];

      const sourceId = doi ?? asString(item.URL) ?? title;
      const issued = asObject(item.issued);
      const dateParts = Array.isArray(issued?.["date-parts"])
        ? issued["date-parts"]
        : [];
      const firstDate = Array.isArray(dateParts[0]) ? dateParts[0] : [];
      const year =
        typeof firstDate[0] === "number" ? firstDate[0] : undefined;
      const urlValue =
        asString(item.URL) ?? (doi ? "https://doi.org/" + doi : undefined);

      return [
        {
          id: makeRecordId("crossref", sourceId),
          source: "crossref",
          title,
          url: urlValue,
          doi,
          externalIds: doi ? { doi } : {},
          authors: authorNames(item.author),
          year,
          abstract: cleanText(item.abstract),
          citationCount: asNumber(item["is-referenced-by-count"]),
          retrievedAt,
          provenance: [
            { source: "crossref", sourceId, url: urlValue },
          ],
        },
      ];
    });
  }
}

export interface OpenAlexOptions extends AdapterHttpOptions {
  apiKey?: string;
}

function openAlexAbstract(value: unknown): string | undefined {
  const index = asObject(value);
  if (!index) return undefined;

  const positions: Array<[number, string]> = [];
  for (const [word, rawPositions] of Object.entries(index)) {
    if (!Array.isArray(rawPositions)) continue;
    for (const position of rawPositions) {
      if (typeof position === "number") positions.push([position, word]);
    }
  }
  if (!positions.length) return undefined;

  return positions
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1])
    .join(" ");
}

export class OpenAlexSource implements ResearchSourceAdapter {
  readonly capabilities: ResearchSourceCapabilities = {
    id: "openalex",
    domains: ["scholarly-graph", "papers", "authors", "institutions"],
    auth: "optional-api-key",
    supports: ["search", "lookup", "citations", "open-access", "full-text-links"],
    notes:
      "Light/demo use can be keyless; a free API key is recommended for production-scale use.",
  };

  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAlexOptions = {}) {
    ({ fetcher: this.fetcher, timeoutMs: this.timeoutMs } =
      httpDefaults(options));
  }

  async search(query: ResearchQuery): Promise<ResearchRecord[]> {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", query.text);
    url.searchParams.set("per_page", String(boundedLimit(query.limit)));
    if (this.options.apiKey) {
      url.searchParams.set("api_key", this.options.apiKey);
    }
    const filters: string[] = [];
    if (query.sinceYear) {
      filters.push("from_publication_date:" + query.sinceYear + "-01-01");
    }
    if (query.openAccessOnly) filters.push("is_oa:true");
    if (filters.length) url.searchParams.set("filter", filters.join(","));

    const root = asObject(await fetchJson(this.fetcher, url, this.timeoutMs));
    const results = Array.isArray(root?.results) ? root.results : [];
    const retrievedAt = nowIso();

    return results.flatMap((raw): ResearchRecord[] => {
      const item = asObject(raw);
      if (!item) return [];

      const sourceId = asString(item.id);
      const title = asString(item.title);
      if (!sourceId || !title) return [];

      const doi = normalizeDoi(item.doi);
      const externalIds: Record<string, string> = { openalex: sourceId };
      if (doi) externalIds.doi = doi;

      const authorships = Array.isArray(item.authorships)
        ? item.authorships
        : [];
      const authors = authorships.flatMap((rawAuthorship): string[] => {
        const authorship = asObject(rawAuthorship);
        const author = asObject(authorship?.author);
        const name = asString(author?.display_name);
        return name ? [name] : [];
      });

      const oa = asObject(item.open_access);
      const primary = asObject(item.primary_location);
      const landing = asString(primary?.landing_page_url);
      const pdf = asString(primary?.pdf_url);
      const urlValue = landing ?? pdf ?? sourceId;

      return [
        {
          id: makeRecordId("openalex", sourceId),
          source: "openalex",
          title,
          url: urlValue,
          doi,
          externalIds,
          authors,
          year: asNumber(item.publication_year),
          publishedAt: asString(item.publication_date),
          abstract: openAlexAbstract(item.abstract_inverted_index),
          citationCount: asNumber(item.cited_by_count),
          openAccess:
            typeof oa?.is_oa === "boolean"
              ? (oa.is_oa as boolean)
              : undefined,
          retrievedAt,
          provenance: [
            { source: "openalex", sourceId, url: urlValue },
          ],
        },
      ];
    });
  }
}

export class EuropePmcSource implements ResearchSourceAdapter {
  readonly capabilities: ResearchSourceCapabilities = {
    id: "europe-pmc",
    domains: ["biomed", "papers", "preprints"],
    auth: "none",
    supports: ["search", "lookup", "citations", "open-access", "full-text-links"],
    notes:
      "Public REST API with OA full-text and annotation links where available.",
  };

  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: AdapterHttpOptions = {}) {
    ({ fetcher: this.fetcher, timeoutMs: this.timeoutMs } =
      httpDefaults(options));
  }

  async search(query: ResearchQuery): Promise<ResearchRecord[]> {
    const url = new URL(
      "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
    );
    const parts = [query.text];
    if (query.sinceYear) {
      parts.push(
        "FIRST_PDATE:[" + query.sinceYear + "-01-01 TO 3000-12-31]",
      );
    }
    if (query.openAccessOnly) parts.push("OPEN_ACCESS:Y");
    url.searchParams.set("query", parts.join(" AND "));
    url.searchParams.set("format", "json");
    url.searchParams.set("resultType", "core");
    url.searchParams.set("pageSize", String(boundedLimit(query.limit)));

    const root = asObject(await fetchJson(this.fetcher, url, this.timeoutMs));
    const resultList = asObject(root?.resultList);
    const results = Array.isArray(resultList?.result)
      ? resultList.result
      : [];
    const retrievedAt = nowIso();

    return results.flatMap((raw): ResearchRecord[] => {
      const item = asObject(raw);
      if (!item) return [];

      const title = asString(item.title);
      const doi = normalizeDoi(item.doi);
      const pmid = asString(item.pmid);
      const pmcid = asString(item.pmcid);
      const sourceId = pmcid ?? pmid ?? doi;
      if (!title || !sourceId) return [];

      const externalIds: Record<string, string> = {};
      if (doi) externalIds.doi = doi;
      if (pmid) externalIds.pmid = pmid;
      if (pmcid) externalIds.pmcid = pmcid;

      const year = asNumber(item.pubYear);
      const urlValue = pmcid
        ? "https://europepmc.org/article/PMC/" + pmcid.replace(/^PMC/i, "")
        : pmid
          ? "https://europepmc.org/article/MED/" + pmid
          : doi
            ? "https://doi.org/" + doi
            : undefined;

      const authorString = asString(item.authorString);
      const authors = authorString
        ? authorString
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : [];

      const oaValue = item.isOpenAccess;
      const openAccess =
        oaValue === true ||
        (typeof oaValue === "string" && oaValue.toUpperCase() === "Y")
          ? true
          : undefined;

      return [
        {
          id: makeRecordId("europe-pmc", sourceId),
          source: "europe-pmc",
          title,
          url: urlValue,
          doi,
          externalIds,
          authors,
          year,
          publishedAt:
            asString(item.firstPublicationDate) ??
            asString(item.electronicPublicationDate),
          abstract: cleanText(item.abstractText),
          citationCount: asNumber(item.citedByCount),
          openAccess,
          retrievedAt,
          provenance: [
            { source: "europe-pmc", sourceId, url: urlValue },
          ],
        },
      ];
    });
  }
}

export interface SemanticScholarOptions extends AdapterHttpOptions {
  apiKey?: string;
}

export class SemanticScholarSource implements ResearchSourceAdapter {
  readonly capabilities: ResearchSourceCapabilities = {
    id: "semantic-scholar",
    domains: ["scholarly-graph", "papers", "citations"],
    auth: "optional-api-key",
    supports: ["search", "lookup", "citations", "open-access"],
    notes:
      "API key improves supported access; obey AI2 license and attribution requirements.",
  };

  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: SemanticScholarOptions = {}) {
    ({ fetcher: this.fetcher, timeoutMs: this.timeoutMs } =
      httpDefaults(options));
  }

  async search(query: ResearchQuery): Promise<ResearchRecord[]> {
    const url = new URL(
      "https://api.semanticscholar.org/graph/v1/paper/search",
    );
    url.searchParams.set("query", query.text);
    url.searchParams.set("limit", String(boundedLimit(query.limit)));
    url.searchParams.set(
      "fields",
      [
        "paperId",
        "title",
        "url",
        "abstract",
        "authors",
        "year",
        "publicationDate",
        "externalIds",
        "citationCount",
        "openAccessPdf",
      ].join(","),
    );
    if (query.sinceYear) {
      url.searchParams.set("year", String(query.sinceYear) + "-");
    }

    const headers = new Headers();
    if (this.options.apiKey) headers.set("x-api-key", this.options.apiKey);

    const root = asObject(
      await fetchJson(this.fetcher, url, this.timeoutMs, { headers }),
    );
    const data = Array.isArray(root?.data) ? root.data : [];
    const retrievedAt = nowIso();

    const records = data.flatMap((raw): ResearchRecord[] => {
      const item = asObject(raw);
      if (!item) return [];

      const sourceId = asString(item.paperId);
      const title = asString(item.title);
      if (!sourceId || !title) return [];

      const rawIds = asObject(item.externalIds);
      const doi = normalizeDoi(rawIds?.DOI);
      const externalIds: Record<string, string> = { s2: sourceId };
      if (doi) externalIds.doi = doi;
      const arxiv = asString(rawIds?.ArXiv);
      if (arxiv) externalIds.arxiv = arxiv;
      const pmid = asString(rawIds?.PubMed);
      if (pmid) externalIds.pmid = pmid;

      const oaPdf = asObject(item.openAccessPdf);
      const oaUrl = asString(oaPdf?.url);
      const urlValue =
        asString(item.url) ??
        oaUrl ??
        "https://www.semanticscholar.org/paper/" + sourceId;

      return [
        {
          id: makeRecordId("semantic-scholar", sourceId),
          source: "semantic-scholar",
          title,
          url: urlValue,
          doi,
          externalIds,
          authors: authorNames(item.authors),
          year: asNumber(item.year),
          publishedAt: asString(item.publicationDate),
          abstract: cleanText(item.abstract),
          citationCount: asNumber(item.citationCount),
          openAccess: oaUrl ? true : undefined,
          retrievedAt,
          provenance: [
            {
              source: "semantic-scholar",
              sourceId,
              url: urlValue,
            },
          ],
        },
      ];
    });

    return query.openAccessOnly
      ? records.filter((record) => record.openAccess === true)
      : records;
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function xmlTag(xml: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const match = xml.match(
    new RegExp(
      "<(?:[A-Za-z0-9_-]+:)?" +
        escaped +
        "[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?" +
        escaped +
        ">",
      "i",
    ),
  );
  return match?.[1] ? decodeXml(match[1]) : undefined;
}

function xmlAuthors(xml: string): string[] {
  const authors: string[] = [];
  const blocks = xml.match(/<author>[\s\S]*?<\/author>/gi) ?? [];
  for (const block of blocks) {
    const name = xmlTag(block, "name");
    if (name) authors.push(name);
  }
  return authors;
}

export class ArxivSource implements ResearchSourceAdapter {
  readonly capabilities: ResearchSourceCapabilities = {
    id: "arxiv",
    domains: ["preprints", "computer-science", "physics", "math"],
    auth: "none",
    supports: ["search", "lookup", "full-text-links"],
    notes: "Public Atom API; keep request cadence conservative.",
  };

  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: AdapterHttpOptions = {}) {
    ({ fetcher: this.fetcher, timeoutMs: this.timeoutMs } =
      httpDefaults(options));
  }

  async search(query: ResearchQuery): Promise<ResearchRecord[]> {
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("search_query", "all:" + query.text);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(boundedLimit(query.limit)));
    url.searchParams.set("sortBy", "submittedDate");
    url.searchParams.set("sortOrder", "descending");

    const response = await fetchResponse(this.fetcher, url, this.timeoutMs);
    const xml = await response.text();
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/gi) ?? [];
    const retrievedAt = nowIso();

    return entries.flatMap((entry): ResearchRecord[] => {
      const title = xmlTag(entry, "title");
      const idUrl = xmlTag(entry, "id");
      if (!title || !idUrl) return [];

      const arxivId = idUrl
        .replace(/^https?:\/\/(?:export\.)?arxiv\.org\/abs\//i, "")
        .replace(/v\d+$/i, "");
      const doi = normalizeDoi(xmlTag(entry, "doi"));
      const publishedAt = xmlTag(entry, "published");
      const year = publishedAt
        ? Number.parseInt(publishedAt.slice(0, 4), 10)
        : undefined;

      if (query.sinceYear && year && year < query.sinceYear) return [];

      const externalIds: Record<string, string> = { arxiv: arxivId };
      if (doi) externalIds.doi = doi;

      return [
        {
          id: makeRecordId("arxiv", arxivId),
          source: "arxiv",
          title,
          url: "https://arxiv.org/abs/" + arxivId,
          doi,
          externalIds,
          authors: xmlAuthors(entry),
          year:
            year !== undefined && Number.isFinite(year)
              ? year
              : undefined,
          publishedAt,
          abstract: xmlTag(entry, "summary"),
          openAccess: true,
          retrievedAt,
          provenance: [
            {
              source: "arxiv",
              sourceId: arxivId,
              url: "https://arxiv.org/abs/" + arxivId,
            },
          ],
        },
      ];
    });
  }
}

export interface DefaultResearchFederationOptions {
  sourceIds?: ResearchSourceId[];
  crossrefMailto?: string;
  openAlexApiKey?: string;
  semanticScholarApiKey?: string;
  timeoutMs?: number;
}

export const ALL_RESEARCH_SOURCE_IDS: readonly ResearchSourceId[] = [
  "arxiv",
  "crossref",
  "openalex",
  "europe-pmc",
  "semantic-scholar",
] as const;

export function isResearchSourceId(value: string): value is ResearchSourceId {
  return (ALL_RESEARCH_SOURCE_IDS as readonly string[]).includes(value);
}

export function createDefaultResearchFederation(
  options: DefaultResearchFederationOptions = {},
): ResearchFederation {
  const enabled = new Set(
    options.sourceIds?.length ? options.sourceIds : ALL_RESEARCH_SOURCE_IDS,
  );
  const common = { timeoutMs: options.timeoutMs };
  const adapters: ResearchSourceAdapter[] = [];

  if (enabled.has("arxiv")) adapters.push(new ArxivSource(common));
  if (enabled.has("crossref")) {
    adapters.push(
      new CrossrefSource({
        ...common,
        mailto: options.crossrefMailto,
      }),
    );
  }
  if (enabled.has("openalex")) {
    adapters.push(
      new OpenAlexSource({
        ...common,
        apiKey: options.openAlexApiKey,
      }),
    );
  }
  if (enabled.has("europe-pmc")) adapters.push(new EuropePmcSource(common));
  if (enabled.has("semantic-scholar")) {
    adapters.push(
      new SemanticScholarSource({
        ...common,
        apiKey: options.semanticScholarApiKey,
      }),
    );
  }

  return new ResearchFederation(adapters);
}
