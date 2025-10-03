"use client";

/**
 * Next.js (App Router) page — Tanzania Judgments Explorer (Pro UX)
 * - Mobile-safe PDF drawer (iOS + Android):
 *   * iOS uses <embed type="application/pdf"> inside a scrollable wrapper (fixes “first page only” bug)
 *   * Android Chrome uses <iframe>; Android WebViews/Firefox fall back to “Open in new tab”
 * - Wrapper owns scrolling with momentum + safe overscroll
 * - Uses dynamic viewport units (svh/dvh) to avoid 100vh bugs
 * - Smooth focus/scroll behavior for the chat panel
 */

import React, { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";

const AnswerDisplay = dynamic(() => import("../components/AnswerDisplay"), { ssr: false });

// ---- Input guards ----------------------------------------------
const MAX_SEARCH_LEN = 160;
const MAX_CHAT_LEN = 800;

// Collapse whitespace and hard-cap length
function sanitizeText(s: string, max: number) {
  return s.replace(/\s+/g, " ").slice(0, max).trim();
}

// Prevent overlong paste; optionally surface a message
function limitPasteIntoInput(
  e: React.ClipboardEvent<HTMLInputElement>,
  max: number,
  setValue: (v: string) => void,
  setMessage?: (v: string | null) => void,
) {
  const pasted = e.clipboardData.getData("text") ?? "";
  if (pasted.length > max) {
    e.preventDefault();
    const clipped = sanitizeText(pasted, max);
    setValue(clipped);
    setMessage?.(`Pasted text was too long; truncated to ${max} characters.`);
  }
}

// ===== API base & helper =====
const ABS_API = (process.env.NEXT_PUBLIC_API_URL || "").trim();
const apiUrl = (path: string) =>
  ABS_API ? `${ABS_API}${path}` : `/api${path.startsWith("/") ? path : `/${path}`}`;

// ----- Types -----
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
  summary?: string;
}
interface ChatChunk {
  text?: string;
  preview?: string;
  chunk_no?: number;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function normalizeSearchResults(data: unknown): SearchHit[] {
  if (isObject(data) && Array.isArray((data as Record<string, unknown>).hits)) {
    return (data as { hits: unknown[] }).hits as SearchHit[];
  }
  if (Array.isArray(data)) return data as SearchHit[];
  return [];
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

/**
 * Exported page: wraps the body in Suspense so useSearchParams() is legal at build time.
 */
export default function Page() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen min-h-[100svh] min-h-[100dvh] bg-slate-950 text-slate-200">
          <div className="mx-auto max-w-5xl p-6">Loading…</div>
        </main>
      }
    >
      <PageBody />
    </Suspense>
  );
}

// ============================================================================
// PageBody() — the page content (uses useSearchParams)
// ============================================================================
function PageBody() {
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

  // --- PDF drawer state + ref ---
  const [pdfPanel, setPdfPanel] = React.useState<{ url: string; title: string } | null>(null);
  const pdfPanelRef = React.useRef<HTMLDivElement>(null);

  // --- Search guidance examples & rotating hint ---
  const EXAMPLES = ["Tundu Lissu", "land disputes", "Judge Mchome", "robbery with violence", "election petition"];
  const [hintIndex, setHintIndex] = React.useState(0);

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

  // ----- Rotate example hint every 4s -----
  React.useEffect(() => {
    const id = setInterval(() => setHintIndex((i) => (i + 1) % EXAMPLES.length), 4000);
    return () => clearInterval(id);
  }, []); // EXAMPLES is a stable literal

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

  // ----- Keyboard shortcut Cmd/Ctrl+/ -----
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

  // --- Close PDF drawer with Esc ---
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPdfPanel(null);
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

  // ----- Robust scroll helper (works across mobile/desktop) -----
  function smartScrollTo(el: Element | null, opts?: ScrollIntoViewOptions) {
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest", ...opts });
    } catch {
      /* no-op */
    }
    // Fallback + extra nudge (mobile address bar / keyboard shifts)
    const se = document.scrollingElement || document.documentElement;
    setTimeout(() => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      const top = rect.top + (window.pageYOffset || document.documentElement.scrollTop) - 8;
      se?.scrollTo({ top, behavior: "smooth" });
    }, 160);
  }

  // ----- Run a search against /search -----
  async function doSearch(qStr?: string) {
    const raw = qStr ?? query;

    const q = sanitizeText(raw, MAX_SEARCH_LEN);
    if (!q) return;

    if (raw.length > MAX_SEARCH_LEN) {
      setErrorMsg(`Search limited to ${MAX_SEARCH_LEN} characters.`);
    }

    writeUrl({ q, doc: null });

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
      const data: unknown = await r.json();
      const hits = normalizeSearchResults(data);

      setResults(hits);
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

  // ----- Clickable example: set + search -----
  function pickExample(example: string) {
    const clipped = sanitizeText(example, MAX_SEARCH_LEN);
    setQuery(clipped);
    void doSearch(clipped);
  }

  // ----- Expand/Collapse a search result -----
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
    const caseLine = meta?.case_line || hit.case_line || "(No case line)";
    const court = meta?.court_title || hit.court_title || "Fetching court…";
    return `${idx + 1}. ${caseLine} — ${court}`;
  }

  function handleSelectDoc(id: number, label: string) {
    setSelectedDoc({ id, label });
    writeUrl({ doc: String(id) });

    // Wait for ChatPanel to mount and paint, then scroll the *chat panel*.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        smartScrollTo(chatPanelRef.current ?? pageEndRef.current, { block: "start" });
        // Avoid keyboard/viewport fighting the scroll: delay focus slightly more on mobile.
        setTimeout(() => {
          const inp = document.querySelector<HTMLInputElement>("#chat-question-input");
          inp?.focus();
        }, 350);
      });
    });
  }

  // --- open/close handlers for PDF drawer ---
  function handleOpenPdf(docId: number | string, title: string) {
    const url = apiUrl(`/doc/${docId}/pdf`);
    setPdfPanel({ url, title });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        smartScrollTo(pdfPanelRef.current, { block: "start" });
      });
    });
  }
  function handleClosePdf() {
    setPdfPanel(null);
  }

  // ---------- Platform detectors (client-only) ----------
  const env = React.useMemo(() => {
    if (typeof navigator === "undefined") {
      return {
        isIOS: false,
        isAndroid: false,
        isFirefoxAndroid: false,
        isAndroidWebView: false,
        inlinePdfLikelySupported: false,
      };
    }
    const ua = navigator.userAgent || "";
    const isIOSDevice = /iPad|iPhone|iPod/.test(ua);
    const isIPadOS13Plus = /Macintosh/.test(ua) && typeof document !== "undefined" && "ontouchend" in document;
    const isIOS = isIOSDevice || isIPadOS13Plus;

    const isAndroid = /Android/i.test(ua);
    const isFirefoxAndroid = isAndroid && /Firefox\/\d+/.test(ua);
    const isAndroidWebView =
      isAndroid && (/\bwv\b/.test(ua) || (!/Chrome\/\d+/.test(ua) && /Version\/\d+\.\d+/.test(ua)));
    const inlinePdfLikelySupported = isAndroid && !isFirefoxAndroid && !isAndroidWebView;

    return { isIOS, isAndroid, isFirefoxAndroid, isAndroidWebView, inlinePdfLikelySupported };
  }, []);

  return (
    <main className="min-h-screen min-h-[100svh] min-h-[100dvh] bg-slate-950 text-slate-200 [background-image:radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.05),transparent_60%)]">
      <div className="h-1 w-full bg-gradient-to-r from-emerald-400 via-cyan-400 to-blue-500" />
      <div className="mx-auto max-w-5xl px-4 py-8 md:py-10">
        <div className="mb-6">
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
            <span className="bg-gradient-to-r from-emerald-300 via-sky-300 to-indigo-300 bg-clip-text text-transparent">
              ⚖️ Tanzania Judgments Explorer
            </span>
          </h1>
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
              onPaste={(e) => limitPasteIntoInput(e, MAX_SEARCH_LEN, setQuery, setErrorMsg)}
              maxLength={MAX_SEARCH_LEN}
              placeholder={`Type to search… e.g. ${EXAMPLES[hintIndex]} (Cmd/Ctrl+/ to focus)`}
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

          {/* Search guidance examples */}
          <div className="mt-3 text-sm text-slate-300/80 flex flex-wrap items-center gap-2">
            <span className="opacity-70">Try:</span>
            {EXAMPLES.slice(0, 4).map((ex, i) => (
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
                                  handleSelectDoc(Number(docId), meta?.case_line || hit.case_line || `Doc ${docId}`)
                                }
                              >
                                💬 Chat with this judgment
                              </button>

                              <button
                                className="ml-auto inline-flex items-center justify-center rounded-xl bg-emerald-500 px-3 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-400 focus-visible:ring-2 focus-visible:ring-emerald-300"
                                onClick={(e) => {
                                  e.preventDefault();
                                  // Open new tab if Ctrl/Cmd pressed
                                  if (e.ctrlKey || e.metaKey) {
                                    window.open(apiUrl(`/doc/${docId}/pdf`), "_blank");
                                    return;
                                  }
                                  handleOpenPdf(Number(docId), meta?.case_line || hit.case_line || `Doc ${docId}`);
                                }}
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
          <div ref={chatPanelRef} id="chat-panel-anchor">
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

        {/* Anchor for smooth scroll to the drawer */}
        <div ref={pdfPanelRef} />

        {/* Bottom PDF drawer (fixed) */}
        {pdfPanel && (
          <div role="region" aria-label="Judgment PDF viewer" className="fixed inset-x-0 bottom-0 z-40">
            {/* Header tab */}
            <div className="mx-auto max-w-5xl px-4">
              <div className="mb-1 inline-flex items-center gap-2 rounded-t-xl border border-slate-700 bg-slate-900 px-3 py-2 shadow-lg">
                <span className="text-sm font-medium text-slate-100 truncate max-w-[70vw]">📄 {pdfPanel.title}</span>
                <button
                  onClick={handleClosePdf}
                  className="ml-2 inline-flex items-center gap-1 rounded-md bg-red-600 hover:bg-red-500 active:bg-red-700 text-white px-2.5 py-1 text-xs font-medium shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                  aria-label="Close PDF"
                  title="Close PDF (Esc)"
                >
                  ✕ Close
                </button>
              </div>
            </div>

            {/* Drawer body */}
            <div className="mx-auto max-w-5xl px-4">
              <div
                className={[
                  // dynamic viewport height avoids mobile address bar issues
                  "h-[45svh] w-full rounded-xl border border-slate-700 bg-slate-900 shadow-2xl",
                  // the container owns scrolling (important for iOS)
                  "overflow-auto md:overflow-hidden",
                  // momentum scrolling + avoid overscroll chaining on iOS
                  "[-webkit-overflow-scrolling:touch] [overscroll-behavior:contain]",
                  // ensure touch gestures are allowed to pan vertically
                  "[touch-action:pan-y] md:[touch-action:auto]",
                ].join(" ")}
              >
                {env.isIOS ? (
                  // iOS: use <embed> for reliable multi-page scrolling inside scrollable wrapper
                  <embed
                    src={`${pdfPanel.url}#toolbar=1&navpanes=0`}
                    type="application/pdf"
                    className="block h-full w-full"
                  />
                ) : env.inlinePdfLikelySupported ? (
                  // Android Chrome & desktop: native viewer in iframe is fine
                  <iframe
                    key={pdfPanel.url}
                    title={pdfPanel.title}
                    src={`${pdfPanel.url}#toolbar=1&navpanes=0&scrollbar=1`}
                    className="block h-full w-full"
                    scrolling="yes"
                  />
                ) : (
                  // Fallback for Firefox Android / WebViews (no inline PDF)
                  <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-slate-200">
                    <p className="text-sm opacity-80">This browser can’t display PDFs inline. Open full screen:</p>
                    <div className="flex gap-2">
                      <a
                        href={pdfPanel.url}
                        target="_blank"
                        rel="noopener"
                        className="rounded-md bg-emerald-500 px-3 py-2 text-emerald-950 hover:bg-emerald-400"
                      >
                        Open in new tab
                      </a>
                      {/* Optional: add a PDF.js viewer route if desired */}
                      {/* <a
                        href={`/pdfjs?file=${encodeURIComponent(pdfPanel.url)}`}
                        className="rounded-md border border-slate-600 px-3 py-2 hover:bg-slate-800"
                      >
                        Use built-in viewer
                      </a> */}
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-2 mb-3 flex items-center justify-between text-xs text-slate-400">
                <span>Tip: Ctrl/Cmd+Click “View Judgement” to open in a new tab.</span>
                <button
                  onClick={handleClosePdf}
                  className="inline-flex items-center gap-1 rounded-md bg-red-600 hover:bg-red-500 active:bg-red-700 text-white px-3 py-1.5 font-medium shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                >
                  ✕ Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Spacer so fixed drawer doesn't cover content on small screens */}
        {pdfPanel && <div aria-hidden className="h-[46svh]" />}

        <div ref={pageEndRef} />
      </div>
    </main>
  );
}

// ============================================================================
// ChatPanel (same features, mobile-friendly input + guards)
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

  async function ask() {
    const q = sanitizeText(question, MAX_CHAT_LEN);
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
      const j: unknown = await r.json();

      const cleaned = cleanLLMAnswer(
        isObject(j) && "answer" in j ? String((j as Record<string, unknown>).answer ?? "(no answer)") : "(no answer)"
      );
      const newChunks: ChatChunk[] =
        isObject(j) && Array.isArray((j as Record<string, unknown>).chunks)
          ? (j as { chunks: ChatChunk[] }).chunks
          : [];

      setAnswer(cleaned);
      setChunks(newChunks);

      const ts = Date.now();
      setQaLog((prev) => [...prev, { q, a: cleaned, chunks: newChunks, ts }]);
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
                    <article
                      className={`rounded-xl border border-indigo-800/60 bg-indigo-900/40 transition ${
                        isOpen ? "shadow-lg" : ""
                      }`}
                    >
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
            onPaste={(e) => limitPasteIntoInput(e, MAX_CHAT_LEN, setQuestion)}
            maxLength={MAX_CHAT_LEN}
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
