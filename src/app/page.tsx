"use client";

/**
 * FIXED: Added streaming support for /chat/stream endpoint
 * - Real-time answer display as tokens arrive
 * - Handles run_id/seq/delta/done/error format
 * - Falls back to sync /chat if streaming fails
 * - Uses display_header from backend when available
 * - Added language detection for English/Swahili UI
 */

import React, { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
const AnswerDisplay = dynamic(() => import("../components/AnswerDisplay"), { ssr: false });

// ---- Language Detection & Translation ----
function detectLanguage(text: string): 'en' | 'sw' {
  const swahiliWords = ['nini', 'kesi', 'lini', 'nani', 'wapi', 'kwa', 'vipi', 'hii', 'hiyo', 'ipi', 'gani', 'swali', 'jibu'];
  const lowerText = text.toLowerCase();
  const swahiliCount = swahiliWords.filter(word => lowerText.includes(word)).length;
  return swahiliCount >= 2 ? 'sw' : 'en';
}

const translations = {
  en: {
    question: "Question",
    answer: "Answer",
    ask: "Ask",
    clearSelection: "Clear selection",
    reset: "Reset",
    streaming: "Streaming…",
    asking: "Asking…",
  },
  sw: {
    question: "Swali",
    answer: "Jibu",
    ask: "Uliza",
    clearSelection: "Futa uchaguzi",
    reset: "Anzisha upya",
    streaming: "Inapakia…",
    asking: "Inauliza…",
  }
};

function getTranslation(questionText: string) {
  const lang = detectLanguage(questionText);
  return translations[lang];
}

// ---- Input guards ----------------------------------------------
const MAX_SEARCH_LEN = 160;
const MAX_CHAT_LEN = 800;

function sanitizeText(s: string, max: number): string {
  return s.replace(/\s+/g, " ").slice(0, max).trim();
}

function limitPasteIntoInput<T extends HTMLInputElement | HTMLTextAreaElement>(
  e: React.ClipboardEvent<T>,
  max: number,
  setValue: (v: string) => void,
  setMessage?: (v: string | null) => void,
) {
  const pasted = e.clipboardData.getData("text") ?? "";
  if (pasted.length > max) {
    e.preventDefault();
    const clipped = sanitizeText(pasted, max);
    setValue(clipped);
    setMessage?.(`Pasted text was clipped to ${max} characters.`);
  }
}

// ===== API base & helper =====
// before:
// const ABS_API = (process.env.NEXT_PUBLIC_API_URL || "").trim();

let ABS_API =
  (process.env.NEXT_PUBLIC_API_URL ||
   process.env.NEXT_PUBLIC_BACKEND_URL ||
   "").trim();

if (!ABS_API && typeof window !== "undefined") {
  // one-time warning in the browser so we know we’re using the proxy
  (window as any).__ABS_API_WARNED__ ||
    (console.warn(
      "[frontend] NEXT_PUBLIC_API_URL / NEXT_PUBLIC_BACKEND_URL is empty — falling back to /api proxy"
    ),
    ((window as any).__ABS_API_WARNED__ = true));
}

const apiUrl = (path: string) =>
  ABS_API ? `${ABS_API}${path}` : `/api${path.startsWith("/") ? path : `/${path}`}`;

// ----- Types -----
interface SearchHit {
  doc_id?: number | string;
  id?: number | string;
  case_line?: string;
  court_title?: string;
  snippet?: string;
  preview?: string;
  text?: string;
  parties?: string;
  date_of_judgment?: string;
  display_header?: string;
}
interface DocMeta {
  case_line?: string;
  court_title?: string;
  parties?: string;
  date_of_judgment?: string;
  summary?: string;
  display_header?: string;
}
interface ChatChunk {
  text?: string;
  preview?: string;
  chunk_no?: number;
  display_header?: string;
}
interface SearchResponsePayload {
  hits?: SearchHit[];
  limit?: number;
  offset?: number;
  next_offset?: number | null;
  prev_offset?: number | null;
  total_count?: number | null;
  page?: number | null;
  total_pages?: number | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeSearchPayload(data: unknown): {
  hits: SearchHit[];
  limit: number;
  offset: number;
  nextOffset: number | null;
  prevOffset: number | null;
  totalCount: number | null;
  page: number;
  totalPages: number | null;
} {
  if (isObject(data)) {
    const obj = data as Record<string, unknown>;

    const rawHits = obj["hits"];
    const hits: SearchHit[] = Array.isArray(rawHits) ? (rawHits as SearchHit[]) : [];

    const rawLimit = obj["limit"];
    const limit = Math.max(1, Number(rawLimit ?? 10) || 10);

    const rawOffset = obj["offset"];
    const offset = Math.max(0, Number(rawOffset ?? 0) || 0);

    const rawNext = obj["next_offset"];
    const nextOffset =
      rawNext === null || rawNext === undefined ? null : Number(rawNext);

    const rawPrev = obj["prev_offset"];
    const prevOffset =
      rawPrev === null || rawPrev === undefined ? null : Number(rawPrev);

    const rawTotal = obj["total_count"];
    const totalCount = typeof rawTotal === "number" ? rawTotal : null;

    const rawPage = obj["page"];
    const pageFromApi = Number(rawPage);

    const rawTotalPages = obj["total_pages"];
    const totalPagesFromApi = Number(rawTotalPages);

    const computedPage = Math.floor(offset / Math.max(1, limit)) + 1;
    const page =
      Number.isFinite(pageFromApi) && pageFromApi > 0 ? pageFromApi : computedPage;

    const totalPages =
      Number.isFinite(totalPagesFromApi) && totalPagesFromApi > 0
        ? totalPagesFromApi
        : totalCount !== null
          ? Math.max(1, Math.ceil(totalCount / Math.max(1, limit)))
          : null;

    return { hits, limit, offset, nextOffset, prevOffset, totalCount, page, totalPages };
  }

  if (Array.isArray(data)) {
    return {
      hits: data as SearchHit[],
      limit: 10,
      offset: 0,
      nextOffset: null,
      prevOffset: null,
      totalCount: null,
      page: 1,
      totalPages: null,
    };
  }

  return {
    hits: [],
    limit: 10,
    offset: 0,
    nextOffset: null,
    prevOffset: null,
    totalCount: null,
    page: 1,
    totalPages: null,
  };
}

async function fetchDocPreview(docId: number, signal?: AbortSignal): Promise<DocMeta | null> {
  try {
    const r = await fetch(apiUrl(`/docs/${docId}/preview`), { signal, cache: "no-store" });
    if (!r.ok) return null;
    const j: unknown = await r.json();
    return isObject(j) ? (j as DocMeta) : null;
  } catch {
    return null;
  }
}

// ----- Small UI helpers -----
function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-amber-300/30 bg-amber-100 text-amber-900 px-4 py-3 text-sm">
      {children}
    </div>
  );
}
function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-slate-800/40 bg-slate-900/60 shadow-lg backdrop-blur ${className}`}>
      {children}
    </div>
  );
}
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold tracking-tight text-slate-100">{children}</h2>;
}

function isTouchDevice() {
  if (typeof window === "undefined") return false;
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

export default function Page() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-slate-950 text-slate-200"><div className="mx-auto max-w-5xl p-6">Loading…</div></main>}>
      <PageBody />
    </Suspense>
  );
}

function PageBody() {
  const router = useRouter();
  const sp = useSearchParams();

  const urlQ = sp.get("q") ?? "";
  const urlDoc = sp.get("doc");
  const urlLimit = Math.max(1, Math.min(50, Number(sp.get("limit") ?? 12) || 12));
  const urlOffset = Math.max(0, Number(sp.get("offset") ?? 0) || 0);

  const [reachable, setReachable] = React.useState<boolean | null>(null);
  const [query, setQuery] = React.useState(urlQ);
  const [isSearching, setIsSearching] = React.useState(false);
  const [results, setResults] = React.useState<SearchHit[]>([]);

  const [limit, setLimit] = React.useState<number>(urlLimit);
  const [offset, setOffset] = React.useState<number>(urlOffset);
  const [nextOffset, setNextOffset] = React.useState<number | null>(null);
  const [prevOffset, setPrevOffset] = React.useState<number | null>(null);
  const [totalCount, setTotalCount] = React.useState<number | null>(null);
  const [page, setPage] = React.useState<number>(1);
  const [totalPages, setTotalPages] = React.useState<number | null>(null);

  const [expandedMeta, setExpandedMeta] = React.useState<Record<number, DocMeta | null>>({});
  const [expandedSet, setExpandedSet] = React.useState<Set<number>>(new Set());
  const [selectedDoc, setSelectedDoc] = React.useState<{ id: number; label: string } | null>(null);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const EXAMPLES = ["Tundu Lissu", "Self Defence","Freedom Of Speech","Land disputes", "Judge Samatta", "Robbery with violence", "Election petition"];
  const [hintIndex, setHintIndex] = React.useState(0);

  const [pageInput, setPageInput] = React.useState<string>("1");

  const searchAbortRef = React.useRef<AbortController | null>(null);
  const metaAbortRef = React.useRef<Map<number, AbortController>>(new Map());
  const searchBoxRef = React.useRef<HTMLInputElement>(null);
  const chatPanelRef = React.useRef<HTMLDivElement>(null);
  const pageEndRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const r = await fetch(apiUrl("/health"), { cache: "no-store" });
        if (ignore) return;
        setReachable(r.ok);
      } catch {
        if (!ignore) setReachable(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  React.useEffect(() => {
    const id = setInterval(() => setHintIndex((i) => (i + 1) % EXAMPLES.length), 4000);
    return () => clearInterval(id);
  }, [EXAMPLES.length]);

  React.useEffect(() => {
    if (urlDoc) {
      const idNum = Number(urlDoc);
      if (Number.isFinite(idNum)) {
        setSelectedDoc((prev) => prev ?? { id: idNum, label: `Doc ${idNum}` });
      }
    }
  }, [urlDoc]);

  React.useEffect(() => {
    if (!query?.trim()) {
      setResults([]);
      setExpandedMeta({});
      setExpandedSet(new Set());
      setNextOffset(null);
      setPrevOffset(null);
      setTotalCount(null);
      setTotalPages(null);
      setPage(1);
      setOffset(0);
      setPageInput("1");
      return;
    }
    const handle = setTimeout(() => {
      setOffset(0);
      setPageInput("1");
      void doSearch(query, 0, limit);
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function writeUrl(params: Record<string, string | null | undefined>) {
    const cur = new URLSearchParams(sp.toString());
    Object.entries(params).forEach(([k, v]) => {
      if (v == null || v === "") cur.delete(k);
      else cur.set(k, String(v));
    });
    const qs = cur.toString();
    router.replace(qs ? `/?${qs}` : "/");
  }

  async function doSearch(qStr: string | undefined, off: number, lim: number) {
    const raw = qStr ?? query;
    const q = sanitizeText(raw, MAX_SEARCH_LEN);
    if (!q) return;

    writeUrl({ q, limit: String(lim), offset: String(off), doc: null });

    searchAbortRef.current?.abort();
    const ac = new AbortController();
    searchAbortRef.current = ac;

    setIsSearching(true);
    setErrorMsg(null);
    try {
      const r = await fetch(apiUrl("/search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, limit: lim, offset: off }),
        signal: ac.signal,
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const data: unknown = await r.json();
      const norm = normalizeSearchPayload(data as SearchResponsePayload | unknown);

      setResults(norm.hits);
      setLimit(norm.limit);
      setOffset(norm.offset);
      setNextOffset(norm.nextOffset);
      setPrevOffset(norm.prevOffset);
      setTotalCount(norm.totalCount);
      setPage(norm.page);
      setTotalPages(norm.totalPages);

      setPageInput(String(norm.page || Math.floor(norm.offset / Math.max(1, norm.limit)) + 1));

      setExpandedMeta({});
      setExpandedSet(new Set());
    } catch (err: unknown) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(msg);
      }
    } finally {
      if (searchAbortRef.current === ac) searchAbortRef.current = null;
      setIsSearching(false);
    }
  }

  function onSubmitSearch(e: React.FormEvent) {
    e.preventDefault();
    void doSearch(query, 0, limit);
  }

  function pickExample(example: string) {
    const clipped = sanitizeText(example, MAX_SEARCH_LEN);
    setQuery(clipped);
    void doSearch(clipped, 0, limit);
  }

  async function toggleExpand(hit: SearchHit) {
    const docId = (hit.doc_id ?? hit.id) as number | string | undefined;
    if (docId == null) return;
    const idNum = Number(docId);
    if (!Number.isFinite(idNum)) return;

    const next = new Set(expandedSet);
    const willOpen = !next.has(idNum);

    if (willOpen) {
      next.add(idNum);
      setExpandedSet(next);

      if (expandedMeta[idNum] === undefined) {
        metaAbortRef.current.get(idNum)?.abort();
        const ac = new AbortController();
        metaAbortRef.current.set(idNum, ac);

        const meta = await fetchDocPreview(idNum, ac.signal);
        setExpandedMeta((m) => ({ ...m, [idNum]: meta }));
        if (metaAbortRef.current.get(idNum) === ac) metaAbortRef.current.delete(idNum);
      }
    } else {
      next.delete(idNum);
      setExpandedSet(next);
    }
  }

  function headerFor(idx: number, hit: SearchHit, meta: DocMeta | null | undefined) {
    if (hit.display_header) {
      const absoluteNo = offset + idx + 1;
      return `${absoluteNo}. ${hit.display_header}`;
    }
    if (meta?.display_header) {
      const absoluteNo = offset + idx + 1;
      return `${absoluteNo}. ${meta.display_header}`;
    }

    const caseLine = (meta?.case_line ?? hit.case_line ?? "(No case line)").trim();
    const rawCourt = (meta?.court_title ?? hit.court_title ?? "").trim();
    const norm = rawCourt
      .replace(/\u2026/g, "...")
      .replace(/\s+/g, " ")
      .replace(/^[([{]\s*|\s*[)\]}]$/g, "")
      .toLowerCase();
    const court = /^(fetching|loading|pending)\s+court/.test(norm) ? "" : rawCourt;

    const absoluteNo = offset + idx + 1;
    const base = `${absoluteNo}. ${caseLine}`;
    return court ? `${base} — ${court}` : base;
  }

  function handleSelectDoc(id: number, label: string) {
    setSelectedDoc({ id, label });
    writeUrl({ doc: String(id) });
  }

  React.useEffect(() => {
    if (!selectedDoc) return;
    const el = chatPanelRef.current ?? pageEndRef.current;
    if (!el) return;

    const delays = [0, 120, 350, 700];
    delays.forEach((d) => {
      setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), d);
    });

    if (!isTouchDevice()) {
      setTimeout(() => {
        const inp = document.querySelector<HTMLInputElement>("#chat-question-input");
        inp?.focus();
      }, 380);
    }
  }, [selectedDoc]);

  React.useEffect(() => {
    if (urlQ.trim()) {
      void doSearch(urlQ, urlOffset, urlLimit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pageStart = results.length ? offset + 1 : 0;
  const pageEnd = offset + results.length;
  const showTotals = totalPages !== null && totalCount !== null;
  const displayPage = page || Math.floor(offset / Math.max(1, limit)) + 1;

  React.useEffect(() => {
    setPageInput(String(displayPage));
  }, [displayPage]);

  function canPrev(): boolean {
    return (prevOffset !== null && prevOffset >= 0) || offset > 0;
  }
  function canNext(): boolean {
    if (nextOffset !== null) return true;
    if (totalCount !== null) return offset + results.length < totalCount;
    return results.length >= Math.max(1, limit);
  }
  function computePrevOffset(): number {
    if (prevOffset !== null && prevOffset >= 0) return prevOffset;
    return Math.max(0, offset - Math.max(1, limit));
  }
  function computeNextOffset(): number | null {
    if (nextOffset !== null) return nextOffset;
    if (results.length < Math.max(1, limit)) return null;
    return offset + Math.max(1, limit);
  }
  function computeLastOffset(): number | null {
    if (totalPages && totalPages > 0) return (totalPages - 1) * Math.max(1, limit);
    if (totalCount !== null)
      return Math.max(0, Math.floor((totalCount - 1) / Math.max(1, limit)) * Math.max(1, limit));
    return null;
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-200 [background-image:radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.05),transparent_60%)]">
      <div className="h-1 w-full bg-gradient-to-r from-emerald-400 via-cyan-400 to-blue-500" />
      <div className="mx-auto max-w-5xl px-4 py-8 md:py-10">
        <div className="mb-6">
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
            <span className="bg-gradient-to-r from-emerald-300 via-sky-300 to-indigo-300 bg-clip-text text-transparent">
              ⚖️ Tanzania Judgments Explorer
            </span>
          </h1>
        </div>

        {reachable === false && <Banner>We are having trouble connecting. Please try again in a moment.</Banner>}

        <Card className="p-5">
          <form onSubmit={onSubmitSearch} className="flex flex-col gap-3 md:flex-row md:items-center" role="search" aria-label="Search judgments">
            <label className="sr-only" htmlFor="q">Search judgments</label>
            <input
              id="q"
              ref={searchBoxRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onPaste={(e) => limitPasteIntoInput(e, MAX_SEARCH_LEN, setQuery, setErrorMsg)}
              maxLength={MAX_SEARCH_LEN}
              placeholder={`Search judgments e.g. ${EXAMPLES[hintIndex]}`}
              className="flex-1 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-400"
              autoComplete="off"
              inputMode="search"
            />

            <div className="flex items-center gap-2">
              <label htmlFor="page-size" className="text-xs text-slate-300">Page</label>
              <select
                id="page-size"
                value={limit}
                onChange={(e) => {
                  const newLimit = Math.max(1, Math.min(50, Number(e.target.value) || 10));
                  setLimit(newLimit);
                  void doSearch(query, 0, newLimit);
                }}
                className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-slate-100"
              >
                {[10, 12, 15, 20, 30, 50].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>

            <button
              type="submit"
              disabled={!query.trim() || isSearching}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 font-medium text-emerald-950 hover:bg-emerald-400 disabled:opacity-60"
              aria-label="Run search"
            >
              {isSearching ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-900 border-t-transparent" />
                  Searching…
                </span>
              ) : (
                <span>Search</span>
              )}
            </button>
          </form>

          {errorMsg && (
            <p className="mt-3 text-sm text-rose-300" role="status" aria-live="polite">
              {errorMsg}
            </p>
          )}

          <div className="mt-3 text-sm text-slate-300/80 flex flex-wrap items-center gap-2">
            <span className="opacity-70">Try:</span>
            {["Tundu Lissu", "Land disputes", "Judge Lubuva", "Robbery with violence"].map((ex, i) => (
              <button
                key={i}
                type="button"
                onClick={() => pickExample(ex)}
                className="rounded-full bg-slate-800 hover:bg-slate-700 px-3 py-1"
              >
                {ex}
              </button>
            ))}
          </div>
        </Card>

        {results.length > 0 ? (
          <div className="mt-6 space-y-3">
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <SectionTitle>📑 Search Results</SectionTitle>
              <div className="text-sm text-slate-300">
                Showing <span className="font-semibold">{pageStart || 0}</span>–<span className="font-semibold">{pageEnd || 0}</span>
                {showTotals && (
                  <>
                    {" "}of <span className="font-semibold">{totalCount}</span> • Page{" "}
                    <span className="font-semibold">{displayPage}</span>
                    {" "}of <span className="font-semibold">{totalPages}</span>
                  </>
                )}
              </div>
            </div>

            <ul className="space-y-3">
              {results.map((hit, idx) => {
                const docId = (hit.doc_id ?? hit.id) as number | string | undefined;
                const idNum = Number(docId);
                const meta = Number.isFinite(idNum) ? expandedMeta[idNum as number] : undefined;

                const snippet = (hit.snippet ?? hit.preview ?? hit.text ?? "").trim();

                const summary = meta?.summary;
                const parties = meta?.parties ?? hit.parties;
                const date = meta?.date_of_judgment ?? hit.date_of_judgment;
                const isOpen = Number.isFinite(idNum) ? expandedSet.has(idNum as number) : false;

                return (
                  <li key={`res-${offset}-${idx}-${docId ?? "noid"}`}>
                    <article
                      className={`group cursor-pointer rounded-2xl border ${
                        isOpen ? "border-slate-700 bg-slate-900/70" : "border-slate-800 bg-slate-900/60"
                      } p-4 outline-none transition hover:border-slate-600 focus-visible:ring-2 focus-visible:ring-cyan-400`}
                      role="button"
                      tabIndex={0}
                      aria-expanded={isOpen}
                      onClick={() => void toggleExpand(hit)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          void toggleExpand(hit);
                        }
                      }}
                    >
                      <header className="flex items-start justify-between gap-3">
                        <h3 className="text-base font-medium text-slate-100">{headerFor(idx, hit, meta)}</h3>
                        <span className="shrink-0 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300">
                          {isOpen ? "Hide" : "Expand"}
                        </span>
                      </header>

                      {(meta?.parties ?? hit.parties) && (
                        <p className="mt-1 text-sm text-slate-300">{meta?.parties ?? hit.parties}</p>
                      )}

                      {isOpen && (
                        <div className="mt-3 space-y-2">
                          {parties && <p className="text-sm">Parties: {parties}</p>}
                          {date && <p className="text-sm">Date: {date}</p>}
                          {snippet && <p className="text-sm text-slate-300">{snippet}</p>}
                          {summary && <p className="text-sm text-slate-300">Summary: {summary}</p>}

                          {docId != null && (
                            <div className="flex gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                              <button
                                className="inline-flex items-center justify-center rounded-xl bg-cyan-500 px-3 py-2 text-sm font-medium text-cyan-950 hover:bg-cyan-400 focus-visible:ring-2 focus-visible:ring-cyan-300"
                                onClick={() =>
                                  handleSelectDoc(
                                    Number(docId),
                                    meta?.display_header
                                      ?? hit.display_header
                                      ?? meta?.case_line
                                      ?? hit.case_line
                                      ?? `Doc ${docId}`
                                  )
                                }
                              >
                                💬 Chat with this judgment
                              </button>

                              <button
                                className="ml-auto inline-flex items-center justify-center rounded-xl bg-emerald-500 px-3 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-400 focus-visible:ring-2 focus-visible:ring-emerald-300"
                                onClick={(e) => {
                                  e.preventDefault();
                                  const url = apiUrl(`/doc/${docId}/pdf`);
                                  if ((e as React.MouseEvent).ctrlKey || (e as React.MouseEvent).metaKey) window.open(url, "_blank");
                                  else window.location.href = url;
                                }}
                              >
                                📄 View Judgment
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  </li>
                );
              })}
            </ul>

            <div className="mt-4 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs text-slate-400">
                Page size: <span className="font-semibold">{limit}</span> • Offset:{" "}
                <span className="font-semibold">{offset}</span>
              </div>

              <div className="flex items-center gap-2">
                <label htmlFor="page-jump" className="text-xs text-slate-300">Go to</label>
                <input
                  id="page-jump"
                  type="number"
                  className="w-20 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-slate-100"
                  min={1}
                  max={totalPages ?? undefined}
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const raw = Number(pageInput);
                      const p = Math.max(1, Math.floor(raw || 1));
                      if (totalPages && p > totalPages) return;
                      const newOffset = (p - 1) * Math.max(1, limit);
                      setOffset(newOffset);
                      void doSearch(query, newOffset, limit);
                    }
                  }}
                  onBlur={() => {
                    const raw = Number(pageInput);
                    const p = Math.max(1, Math.floor(raw || displayPage));
                    setPageInput(String(Math.min(totalPages ?? p, p)));
                  }}
                  disabled={!showTotals || isSearching}
                />

                <button
                  type="button"
                  className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
                  disabled={isSearching || !canPrev() || offset === 0}
                  onClick={() => {
                    if (!canPrev() || offset === 0) return;
                    setOffset(0);
                    void doSearch(query, 0, limit);
                  }}
                  title="First page"
                >
                  « First
                </button>

                <button
                  type="button"
                  className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
                  disabled={isSearching || !canPrev()}
                  onClick={() => {
                    if (!canPrev()) return;
                    const newOff = computePrevOffset();
                    setOffset(newOff);
                    void doSearch(query, newOff, limit);
                  }}
                  title="Previous page"
                >
                  ← Prev
                </button>

                <button
                  type="button"
                  className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
                  disabled={isSearching || !canNext()}
                  onClick={() => {
                    if (!canNext()) return;
                    const newOff = nextOffset !== null ? nextOffset : computeNextOffset();
                    if (newOff === null) return;
                    setOffset(newOff);
                    void doSearch(query, newOff, limit);
                  }}
                  title="Next page"
                >
                  Next →
                </button>

                <button
                  type="button"
                  className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
                  disabled={
                    isSearching ||
                    computeLastOffset() === null ||
                    (totalPages !== null && displayPage >= totalPages)
                  }
                  onClick={() => {
                    const lastOff = computeLastOffset();
                    if (lastOff === null) return;
                    setOffset(lastOff);
                    void doSearch(query, lastOff, limit);
                  }}
                  title="Last page"
                >
                  Last »
                </button>
              </div>
            </div>
          </div>
        ) : (
          query.trim() !== "" &&
          !isSearching && <p className="mt-6 text-sm text-slate-400">No results for &quot;{query}&quot;. Try different keywords.</p>
        )}

        {selectedDoc && (
          <div ref={chatPanelRef}>
            <ChatPanel
              key={`chat-${selectedDoc.id}`}
              selectedDoc={selectedDoc}
              onClear={() => {
                setSelectedDoc(null);
                writeUrl({ doc: null });
              }}
            />
          </div>
        )}

        <div ref={pageEndRef} />
      </div>
    </main>
  );
}

// ============================================================================
// ChatPanel - WITH STREAMING SUPPORT & LANGUAGE DETECTION
// ============================================================================
function ChatPanel({
  selectedDoc,
  onClear,
}: {
  selectedDoc: { id: number; label: string };
  onClear: () => void;
}) {
  function cleanLLMAnswer(raw: string): string {
    return String(raw)
      .replace(/^\s*(?:#{1,6}\s*)?(?:answer|final answer|response|reply|jibu)\s*:?\s*\n+/i, "")
      .trim();
  }

  type QaItem = { q: string; a: string; ts: number; chunks?: ChatChunk[] };

  const [question, setQuestion] = React.useState("");
  const [lastQuestion, setLastQuestion] = React.useState<string | null>(null);
  const [k, setK] = React.useState(6);
  const [isLoading, setIsLoading] = React.useState(false);
  const [answer, setAnswer] = React.useState<string | null>(null);
  const [chunks, setChunks] = React.useState<ChatChunk[]>([]);
  const [showSources, setShowSources] = React.useState(false);

  const [qaLog, setQaLog] = React.useState<QaItem[]>([]);
  const [expandedHistory, setExpandedHistory] = React.useState<Set<number>>(new Set());
  const [historyExcerpts, setHistoryExcerpts] = React.useState<Record<number, boolean>>({});

  const [isStreaming, setIsStreaming] = React.useState(false);
  const [streamingAnswer, setStreamingAnswer] = React.useState<string>("");

  const askAbortRef = React.useRef<AbortController | null>(null);

  // Detect language from last question
  const t = getTranslation(lastQuestion || question);

  function toggleHistory(ts: number) {
    setExpandedHistory((prev) => {
      const n = new Set(prev);
      if (n.has(ts)) n.delete(ts);
      else n.add(ts);
      return n;
    });
  }
  function toggleHistoryExcerpts(ts: number) {
    setHistoryExcerpts((prev) => ({ ...prev, [ts]: !prev[ts] }));
  }

  async function askStreaming() {
    const q = sanitizeText(question, MAX_CHAT_LEN);
    if (!q) return;

    askAbortRef.current?.abort();
    const ac = new AbortController();
    askAbortRef.current = ac;

    setLastQuestion(q);
    setQuestion("");
    setIsStreaming(true);
    setStreamingAnswer("");
    setAnswer(null);
    setChunks([]);
    setShowSources(false);

    try {
      const r = await fetch(apiUrl("/chat/stream"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: Number(selectedDoc.id), question: q, k }),
        signal: ac.signal,
      });

      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      if (!r.body) throw new Error("No response body");

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulatedAnswer = "";
      let currentRunId: string | null = null;
      let isDone = false;

      while (!isDone) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const json = JSON.parse(line);

            if (json.error) throw new Error(json.error);

            if (json.run_id && !currentRunId) {
              currentRunId = json.run_id;
            }

            if (json.delta && typeof json.delta === "string") {
              accumulatedAnswer += json.delta;
              setStreamingAnswer(accumulatedAnswer);
            }

            if (json.done === true) {
              isDone = true;
              break;
            }
          } catch (parseErr) {
            console.warn("Failed to parse streaming line:", line, parseErr);
          }
        }
      }

      const cleaned = cleanLLMAnswer(accumulatedAnswer);
      setAnswer(cleaned);
      setStreamingAnswer("");

      const ts = Date.now();
      setQaLog((prev) => [...prev, { q, a: cleaned, chunks: [], ts }]);

    } catch (err: unknown) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Streaming error:", msg);
        await askSync(q);
        return;
      }
    } finally {
      if (askAbortRef.current === ac) askAbortRef.current = null;
      setIsStreaming(false);
    }
  }

  async function askSync(q?: string) {
    const question = q ? sanitizeText(q, MAX_CHAT_LEN) : "";
    if (!question) return;

    askAbortRef.current?.abort();
    const ac = new AbortController();
    askAbortRef.current = ac;

    if (!q) {
      setLastQuestion(question);
      setQuestion("");
    }

    setIsLoading(true);
    setAnswer(null);
    setChunks([]);
    setShowSources(false);

    try {
      const r = await fetch(apiUrl("/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: Number(selectedDoc.id), question, k }),
        signal: ac.signal,
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const j: unknown = await r.json();

      const cleaned = cleanLLMAnswer(
        isObject(j) && "answer" in j ? String((j as Record<string, unknown>).answer ?? "(no answer)") : "(no answer)"
      );
      const newChunks: ChatChunk[] =
        isObject(j) && Array.isArray((j as Record<string, unknown>).chunks)
          ? ((j as { chunks: ChatChunk[] }).chunks)
          : [];

      setAnswer(cleaned);
      setChunks(newChunks);

      const ts = Date.now();
      setQaLog((prev) => [...prev, { q: question, a: cleaned, chunks: newChunks, ts }]);
    } catch (err: unknown) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        const msg = err instanceof Error ? err.message : String(err);
        alert(`Chat error: ${msg}`);
      }
    } finally {
      if (askAbortRef.current === ac) askAbortRef.current = null;
      setIsLoading(false);
    }
  }

  async function ask() {
    await askStreaming();
  }

  const displayAnswer = isStreaming ? streamingAnswer : answer;
  const answerMarkdown =
    displayAnswer == null ? null : (lastQuestion ? `## ${t.question}\n${lastQuestion}\n\n## ${t.answer}\n` : "") + String(displayAnswer);

  return (
    <div id="chat-panel" className="mt-8">
      <SectionTitle>💬 Chatting with: {selectedDoc.label}</SectionTitle>

      <Card className="mt-3 p-5 bg-indigo-950/70 border-indigo-700">
        {qaLog.length > 0 && (
          <div className="mb-5">
            <div className="mb-2 text-xs font-medium text-indigo-200/90">
              This session: {qaLog.length} question{qaLog.length === 1 ? "" : "s"}
            </div>
            <ul className="space-y-3">
              {[...qaLog].reverse().map((item) => {
                const isOpen = expandedHistory.has(item.ts);
                const showHx = !!historyExcerpts[item.ts];
                const cardId = `qa-${item.ts}`;
                const itemT = getTranslation(item.q);
                return (
                  <li key={item.ts}>
                    <article className={`rounded-xl border border-indigo-800/60 bg-indigo-900/40 transition ${isOpen ? "shadow-lg" : ""}`}>
                      <button
                        className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left"
                        onClick={() => toggleHistory(item.ts)}
                        aria-expanded={isOpen}
                        aria-controls={cardId}
                      >
                        <div className="min-w-0">
                          <div className="font-medium text-indigo-100 truncate">{itemT.question}: {item.q}</div>
                          {!isOpen && (
                            <div className="mt-1 text-sm text-indigo-200/90 line-clamp-1">
                              {itemT.answer}: {item.a}
                            </div>
                          )}
                        </div>
                        <span className="shrink-0 rounded-md border border-indigo-700 px-2 py-1 text-xs text-indigo-200">
                          {isOpen ? "Hide" : "Expand"}
                        </span>
                      </button>

                      {isOpen && (
                        <div id={cardId} className="px-3 pb-3">
                          <div className="mt-2">
                            <AnswerDisplay markdown={`## ${itemT.question}\n${item.q}\n\n## ${itemT.answer}\n${item.a}`} />
                          </div>

                          {Array.isArray(item.chunks) && item.chunks.length > 0 && (
                            <div className="mt-3">
                              <button
                                className="rounded-md border border-indigo-700 px-2 py-1 text-xs text-indigo-200 hover:bg-indigo-900"
                                onClick={() => toggleHistoryExcerpts(item.ts)}
                              >
                                {showHx ? "Hide excerpts" : "Show excerpts"}
                              </button>
                              {showHx && (
                                <div className="mt-2 space-y-2">
                                  {item.chunks.map((ch, i) => (
                                    <div key={i} className="rounded bg-indigo-800/40 p-2 text-sm text-indigo-100">
                                      <div className="mb-1 font-medium text-indigo-200/90">
                                        Excerpt [{ch.chunk_no ?? i + 1}]
                                      </div>
                                      {ch.display_header && (
                                        <div className="mb-1 text-indigo-200/80">
                                          {ch.display_header}
                                        </div>
                                      )}
                                      <p className="whitespace-pre-wrap break-words leading-relaxed">
                                        {(ch.text ?? ch.preview ?? "").trim()}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {answerMarkdown && (
          <div className="mt-0 mb-4" aria-live="polite">
            {isStreaming && (
              <div className="mb-2 flex items-center gap-2 text-xs text-indigo-300">
                <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
                <span>{t.streaming}</span>
              </div>
            )}
            <AnswerDisplay markdown={answerMarkdown} />
          </div>
        )}

        {chunks.length > 0 && (
          <>
            <div className="mt-2 flex items-center gap-2">
              <input
                id="toggle-sources"
                type="checkbox"
                checked={showSources}
                onChange={(e) => setShowSources(e.target.checked)}
                className="h-4 w-4 cursor-pointer"
              />
              <label htmlFor="toggle-sources" className="text-sm text-indigo-200 cursor-pointer">
                Show supporting excerpts
              </label>
            </div>
            {showSources && (
              <div className="mt-2 space-y-2">
                {chunks.map((ch, i) => (
                  <div key={i} className="rounded bg-indigo-800/50 p-3 text-sm text-indigo-100">
                    <div className="mb-1 font-medium text-indigo-200/90">Excerpt [{ch.chunk_no ?? i + 1}]</div>
                    {ch.display_header && (
                      <div className="mb-1 text-indigo-200/80">
                        {ch.display_header}
                      </div>
                    )}
                    <p className="whitespace-pre-wrap break-words leading-relaxed">
                      {(ch.text ?? ch.preview ?? "").trim()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center">
          <textarea
            id="chat-question-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onPaste={(e) => limitPasteIntoInput(e, MAX_CHAT_LEN, setQuestion)}
            maxLength={MAX_CHAT_LEN}
            placeholder={
              lastQuestion
                ? "Enter another question about this judgment…"
                : "Enter your question about this judgment (e.g., final orders, parties, issues)…"
            }
            className="flex-1 h-24 rounded-xl border border-stone-300 bg-stone-50 px-4 py-3 text-stone-900 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask();
              }
            }}
          />
          <div className="flex items-center gap-3">
            <label className="text-xs text-indigo-200" htmlFor="k-range">k</label>
            <input
              id="k-range"
              type="range"
              min={2}
              max={12}
              step={1}
              value={k}
              onChange={(e) => setK(Number(e.target.value))}
              className="h-2 w-24 cursor-pointer appearance-none rounded-lg bg-indigo-800"
              aria-valuemin={2}
              aria-valuemax={12}
              aria-valuenow={k}
            />
            <span className="w-6 text-center text-xs text-indigo-200">{k}</span>
            <button
              onClick={() => void ask()}
              disabled={!question.trim() || isLoading || isStreaming}
              className="rounded-xl bg-indigo-500 px-4 py-3 font-medium text-indigo-950 hover:bg-indigo-400 disabled:opacity-60"
              aria-label="Ask question"
            >
              {isLoading || isStreaming ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-900 border-t-transparent" />
                  {isStreaming ? t.streaming : t.asking}
                </span>
              ) : (
                <span>{t.ask}</span>
              )}
            </button>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button className="rounded bg-rose-500 px-3 py-2 text-sm text-white hover:bg-rose-400" onClick={onClear}>
            🔄 {t.clearSelection}
          </button>
          <button
            className="rounded border border-indigo-700 px-3 py-2 text-sm text-indigo-200 hover:bg-indigo-900"
            onClick={() => {
              setQuestion("");
              setAnswer(null);
              setChunks([]);
              setStreamingAnswer("");
              askAbortRef.current?.abort();
            }}
          >
            {t.reset}
          </button>
        </div>
      </Card>
    </div>
  );
}