"use client";

/**
 * Next.js (App Router) page — Tanzania Judgments Explorer (Pro UX)
 * ----------------------------------------------------------------
 * Works in two modes:
 *  A) ENV  : Set NEXT_PUBLIC_API_URL (e.g., https://<backend-id>.ngrok-free.app)
 *  B) Proxy: Leave it unset and add a Next.js rewrite: /api/* -> http://localhost:8000/*
 */

import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AnswerDisplay from "../components/AnswerDisplay"; // Markdown-rendered answer card

// ===== API base & helper =====
const ABS_API = (process.env.NEXT_PUBLIC_API_URL || "").trim();
// If ABS_API is set, use it. Otherwise, fall back to Next proxy path /api/*
const apiUrl = (path: string) =>
  ABS_API ? `${ABS_API}${path}` : `/api${path.startsWith("/") ? path : `/${path}`}`;

// ----- Types for search results and document meta returned by your FastAPI -----
interface SearchHit {
  doc_id?: number | string;
  id?: number | string;
  case_line?: string;
  court_title?: string;
  snippet?: string;
  text?: string;
  parties?: string;
  date_of_judgment?: string;
}

interface DocMeta {
  case_line?: string;
  court_title?: string;
  parties?: string;
  date_of_judgment?: string;
  summary?: string; // NEW
}

interface ChatChunk {
  text?: string;
  preview?: string;
  chunk_no?: number;
}

// ----- Normalize / unwrap different search payload shapes to a SearchHit[] -----
function normalizeSearchResults(data: any): SearchHit[] {
  if (data && typeof data === "object" && Array.isArray(data.hits)) return data.hits;
  if (Array.isArray(data)) return data as SearchHit[];
  return [];
}

// [NEW] Preview fetch (uses /docs/{id}/preview and returns summary + light meta)
async function fetchDocPreview(docId: number, signal?: AbortSignal): Promise<DocMeta | null> {
  try {
    const r = await fetch(apiUrl(`/docs/${docId}/preview`), { signal, cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return j as DocMeta | null;
  } catch {
    return null;
  }
}

// ----- Small UI helpers (Banner, Card, SectionTitle) -----
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

// ============================================================================
// Page() — top-level page component: search UI, results, and chat panel mount
// ============================================================================
export default function Page() {
  const router = useRouter();
  const sp = useSearchParams();

  // ----- Read URL state -----
  const urlQ = sp.get("q") ?? "";
  const urlDoc = sp.get("doc");

  // ----- Local UI state -----
  const [reachable, setReachable] = React.useState<boolean | null>(null);
  const [query, setQuery] = React.useState(urlQ);
  const [isSearching, setIsSearching] = React.useState(false);
  const [results, setResults] = React.useState<SearchHit[]>([]);
  const [expandedMeta, setExpandedMeta] = React.useState<Record<number, DocMeta | null>>({});
  const [expandedSet, setExpandedSet] = React.useState<Set<number>>(new Set());
  const [selectedDoc, setSelectedDoc] = React.useState<{ id: number; label: string } | null>(null);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  // ----- Refs -----
  const searchAbortRef = React.useRef<AbortController | null>(null);
  const metaAbortRef = React.useRef<Map<number, AbortController>>(new Map());
  const searchBoxRef = React.useRef<HTMLInputElement>(null);
  const chatPanelRef = React.useRef<HTMLDivElement>(null);
  const pageEndRef = React.useRef<HTMLDivElement>(null);

  // ----- Backend health check on first mount -----
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

  // ----- If URL has ?doc=, reflect it into selectedDoc on first load -----
  React.useEffect(() => {
    if (urlDoc) {
      const idNum = Number(urlDoc);
      if (Number.isFinite(idNum)) {
        setSelectedDoc((prev) => prev ?? { id: idNum, label: `Doc ${idNum}` });
      }
    }
  }, [urlDoc]);

  // ----- Debounced search whenever "query" changes -----
  React.useEffect(() => {
    if (!query?.trim()) {
      setResults([]);
      setExpandedMeta({});
      setExpandedSet(new Set());
      return;
    }
    const handle = setTimeout(() => {
      void doSearch(query);
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // ----- Keyboard shortcut Cmd/Ctrl+/ to focus the search input -----
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const meta = isMac ? e.metaKey : e.ctrlKey;
      if (meta && e.key === "/") {
        e.preventDefault();
        searchBoxRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ----- Helper: write certain keys back into the URL (q, doc) -----
  function writeUrl(params: Record<string, string | null | undefined>) {
    const cur = new URLSearchParams(sp.toString());
    Object.entries(params).forEach(([k, v]) => {
      if (v == null || v === "") cur.delete(k);
      else cur.set(k, String(v));
    });
    const qs = cur.toString();
    router.replace(qs ? `/?${qs}` : "/");
  }

  // ----- Run a search against /search (POST) with the current query -----
  async function doSearch(qStr?: string) {
    const q = (qStr ?? query).trim();
    if (!q) return;

    // reflect query into URL, clear any selected doc
    writeUrl({ q, doc: null });

    // cancel any previous in-flight search
    searchAbortRef.current?.abort();
    const ac = new AbortController();
    searchAbortRef.current = ac;

    setIsSearching(true);
    setErrorMsg(null);
    try {
      const r = await fetch(apiUrl("/search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, limit: 12 }),
        signal: ac.signal,
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const data = await r.json();
      const hits = normalizeSearchResults(data);

      setResults(hits);
      setExpandedMeta({});
      setExpandedSet(new Set());
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setErrorMsg(err?.message ?? String(err));
      }
    } finally {
      if (searchAbortRef.current === ac) searchAbortRef.current = null;
      setIsSearching(false);
    }
  }

  // ----- Expand/Collapse a search result; fetch its meta on first open -----
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

        const meta = await fetchDocPreview(idNum, ac.signal); // preview fetch
        setExpandedMeta((m) => ({ ...m, [idNum]: meta }));
        if (metaAbortRef.current.get(idNum) === ac) metaAbortRef.current.delete(idNum);
      }
    } else {
      next.delete(idNum);
      setExpandedSet(next);
    }
  }

  function headerFor(idx: number, hit: SearchHit, meta: DocMeta | null | undefined) {
    const caseLine = meta?.case_line || hit.case_line || "(No case line)";
    const court = meta?.court_title || hit.court_title || "Fetching court…";
    return `${idx + 1}. ${caseLine} — ${court}`;
  }

  function handleSelectDoc(id: number, label: string) {
    setSelectedDoc({ id, label });
    writeUrl({ doc: String(id) });

    requestAnimationFrame(() => {
      pageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      const inp = document.querySelector<HTMLInputElement>("#chat-question-input");
      if (inp) setTimeout(() => inp.focus(), 250);
    });
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
          <p className="mt-2 text-slate-300/90">Search, Chat, and View Court Judgments — Smarter with AI.</p>
        </div>

        {reachable === false && <Banner>Backend API is not reachable. Make sure FastAPI is running.</Banner>}

        <Card className="p-5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void doSearch();
            }}
            className="flex flex-col gap-3 md:flex-row md:items-center"
            role="search"
            aria-label="Search judgments"
          >
            <label className="sr-only" htmlFor="q">
              Search judgments
            </label>
            <input
              id="q"
              ref={searchBoxRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to search… (Cmd/Ctrl+/ to focus)"
              className="flex-1 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-400"
              autoComplete="off"
              inputMode="search"
            />
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
        </Card>

        {results.length > 0 ? (
          <div className="mt-6 space-y-3">
            <SectionTitle>📑 Search Results</SectionTitle>
            <ul className="space-y-3">
              {results.map((hit, idx) => {
                const docId = (hit.doc_id ?? hit.id) as number | string | undefined;
                const idNum = Number(docId);
                const meta = Number.isFinite(idNum) ? expandedMeta[idNum as number] : undefined;
                const snippet = hit.snippet || hit.text || "";
                const summary = meta?.summary;
                const parties = meta?.parties ?? hit.parties;
                const date = meta?.date_of_judgment ?? hit.date_of_judgment;
                const isOpen = Number.isFinite(idNum) ? expandedSet.has(idNum as number) : false;

                return (
                  <li key={`res-${idx}-${docId ?? "noid"}`}>
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
                                    meta?.case_line || hit.case_line || `Doc ${docId}`
                                  )
                                }
                              >
                                💬 Chat with this judgment
                              </button>

                              <button
                                className="ml-auto inline-flex items-center justify-center rounded-xl bg-emerald-500 px-3 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-400 focus-visible:ring-2 focus-visible:ring-emerald-300"
                                onClick={() => window.open(apiUrl(`/doc/${docId}/pdf`), "_blank")}
                              >
                                📄 View Judgement
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
          </div>
        ) : (
          query.trim() !== "" &&
          !isSearching && <p className="mt-6 text-sm text-slate-400">No results for “{query}”. Try different keywords.</p>
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
// ChatPanel() — ask a question about the selected doc, show answer + history
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
      .replace(/^\s*(?:#{1,6}\s*)?(?:answer|final answer|response|reply)\s*:?\s*\n+/i, "")
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

  const askAbortRef = React.useRef<AbortController | null>(null);

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

  // ----- Ask the backend: /chat (POST) with doc_id, question, k -----
  async function ask() {
    const q = question.trim();
    if (!q) return;

    askAbortRef.current?.abort();
    const ac = new AbortController();
    askAbortRef.current = ac;

    setLastQuestion(q);
    setQuestion("");

    setIsLoading(true);
    setAnswer(null);
    setChunks([]);
    setShowSources(false);

    try {
      const r = await fetch(apiUrl("/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: Number(selectedDoc.id), question: q, k }),
        signal: ac.signal,
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const j = await r.json();

      const cleaned = cleanLLMAnswer(j?.answer ?? "(no answer)");
      const newChunks: ChatChunk[] = Array.isArray(j?.chunks) ? j.chunks : [];
      setAnswer(cleaned);
      setChunks(newChunks);

      const ts = Date.now();
      setQaLog((prev) => [...prev, { q, a: cleaned, chunks: newChunks, ts }]);
    } catch (err: any) {
      if (err?.name !== "AbortError") alert(`Chat error: ${err?.message ?? err}`);
    } finally {
      if (askAbortRef.current === ac) askAbortRef.current = null;
      setIsLoading(false);
    }
  }

  const answerMarkdown =
    answer == null ? null : (lastQuestion ? `## Question\n${lastQuestion}\n\n## Answer\n` : "") + String(answer);

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
                          <div className="font-medium text-indigo-100 truncate">Q: {item.q}</div>
                          <div className={`mt-1 text-sm text-indigo-200/90 ${isOpen ? "" : "line-clamp-1"}`}>
                            A: {item.a}
                          </div>
                        </div>
                        <span className="shrink-0 rounded-md border border-indigo-700 px-2 py-1 text-xs text-indigo-200">
                          {isOpen ? "Hide" : "Expand"}
                        </span>
                      </button>

                      {isOpen && (
                        <div id={cardId} className="px-3 pb-3">
                          <div className="mt-2">
                            <AnswerDisplay markdown={`## Question\n${item.q}\n\n## Answer\n${item.a}`} />
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
          <input
            id="chat-question-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={
              lastQuestion
                ? "Enter another question about this judgment…"
                : "Enter your question about this judgment (e.g., final orders, parties, issues)…"
            }
            className="flex-1 h-24 rounded-xl border border-stone-300 bg-stone-50 px-4 py-3 text-stone-900 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
            autoComplete="off"
            inputMode="search"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask();
              }
            }}
          />
          <div className="flex items-center gap-3">
            <label className="text-xs text-indigo-200" htmlFor="k-range">
              k
            </label>
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
              disabled={!question.trim() || isLoading}
              className="rounded-xl bg-indigo-500 px-4 py-3 font-medium text-indigo-950 hover:bg-indigo-400 disabled:opacity-60"
              aria-label="Ask question"
            >
              {isLoading ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-900 border-t-transparent" />
                  Asking…
                </span>
              ) : (
                <span>Ask</span>
              )}
            </button>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button className="rounded bg-rose-500 px-3 py-2 text-sm text-white hover:bg-rose-400" onClick={onClear}>
            🔄 Clear selection
          </button>
          <button
            className="rounded border border-indigo-700 px-3 py-2 text-sm text-indigo-200 hover:bg-indigo-900"
            onClick={() => {
              setQuestion("");
              setAnswer(null);
              setChunks([]);
              askAbortRef.current?.abort();
            }}
          >
            Reset
          </button>
        </div>
      </Card>
    </div>
  );
}
