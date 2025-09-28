"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  markdown: string;
  className?: string;
  /** Set false if you want to KEEP the leading ## Answer from markdown */
  autoStripTopAnswerHeading?: boolean;
  /** Set false to hide the card’s “Model answer” title instead */
  showCardTitle?: boolean;
};

function stripLeadingAnswerHeading(md: string): string {
  // Trim leading whitespace to normalize the first line
  const lines = md.replace(/^\uFEFF/, "").trimStart().split(/\r?\n/);
  if (lines.length === 0) return md;

  // Match "## Answer" or "### Answer" (optionally with a colon), case-insensitive, only if it's the FIRST non-empty line
  const first = lines[0].trim();
  if (/^#{2,3}\s*answer\b[:]?\s*$/i.test(first)) {
    // Remove the heading line and any immediately following blank lines
    let i = 1;
    while (i < lines.length && /^\s*$/.test(lines[i])) i++;
    return lines.slice(i).join("\n");
  }

  // Also handle a plain H1 case some models might emit
  if (/^#\s*answer\b[:]?\s*$/i.test(first)) {
    let i = 1;
    while (i < lines.length && /^\s*$/.test(lines[i])) i++;
    return lines.slice(i).join("\n");
  }

  return md;
}

export default function AnswerDisplay({
  markdown,
  className = "",
  autoStripTopAnswerHeading = true,
  showCardTitle = true,
}: Props) {
  const [copied, setCopied] = React.useState(false);

  const displayMarkdown = React.useMemo(() => {
    return autoStripTopAnswerHeading ? stripLeadingAnswerHeading(markdown) : markdown;
  }, [markdown, autoStripTopAnswerHeading]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(displayMarkdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* no-op */
    }
  }

  return (
    <section className={`answer-card ${className}`}>
      {showCardTitle && (
        <header className="answer-header">
          <div className="answer-icon" aria-hidden>
            💡
          </div>
          <h3 className="answer-title">Model answer</h3>
          <button className="answer-copy" onClick={copy} aria-label="Copy answer">
            {copied ? "Copied" : "Copy"}
          </button>
        </header>
      )}

      {!showCardTitle && (
        <div className="mb-2 flex justify-end">
          <button className="answer-copy" onClick={copy} aria-label="Copy answer">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}

      <div className="answer-container">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayMarkdown}</ReactMarkdown>
      </div>
    </section>
  );
}
