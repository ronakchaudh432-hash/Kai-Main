"use client";

// Minimal markdown renderer (no extra deps): code blocks with copy button,
// inline code, bold/italic, headings, lists, links, paragraphs. Output is
// escaped first, then formatted — never raw HTML from the model.

import React, { useState, useMemo } from "react";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(md: string): string {
  let s = escapeHtml(md);
  s = s.replace(/`([^`\n]+)`/g, "<code class=\"md-inline-code\">$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<a href=\"$2\" target=\"_blank\" rel=\"noopener noreferrer\">$1</a>");
  return s;
}

interface Block {
  key: string;
  html?: string;
  code?: string;
  lang?: string;
}

function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  const fence = /```(\w*)\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  const pushProse = (text: string) => {
    const lines = text.split("\n");
    let html = "";
    let listType: "ul" | "ol" | null = null;
    for (const line of lines) {
      const t = line.trimEnd();
      if (/^\s*[-*]\s+/.test(t)) {
        if (listType !== "ul") {
          if (listType) html += `</${listType}>`;
          html += '<ul class="md-list">';
          listType = "ul";
        }
        html += `<li>${inline(t.replace(/^\s*[-*]\s+/, ""))}</li>`;
      } else if (/^\s*\d+[.)]\s+/.test(t)) {
        if (listType !== "ol") {
          if (listType) html += `</${listType}>`;
          html += '<ol class="md-list">';
          listType = "ol";
        }
        html += `<li>${inline(t.replace(/^\s*\d+[.)]\s+/, ""))}</li>`;
      } else {
        if (listType) {
          html += `</${listType}>`;
          listType = null;
        }
        if (/^###\s+/.test(t)) html += `<h4 class="md-h">${inline(t.replace(/^###\s+/, ""))}</h4>`;
        else if (/^##\s+/.test(t)) html += `<h3 class="md-h">${inline(t.replace(/^##\s+/, ""))}</h3>`;
        else if (/^#\s+/.test(t)) html += `<h2 class="md-h">${inline(t.replace(/^#\s+/, ""))}</h2>`;
        else if (t.trim() === "") html += "";
        else html += `<p class="md-p">${inline(t)}</p>`;
      }
    }
    if (listType) html += `</${listType}>`;
    if (html) blocks.push({ key: `p${i++}`, html });
  };
  while ((m = fence.exec(src)) !== null) {
    if (m.index > last) pushProse(src.slice(last, m.index));
    blocks.push({ key: `c${i++}`, code: m[2].replace(/\n$/, ""), lang: m[1] || "code" });
    last = m.index + m[0].length;
  }
  if (last < src.length) pushProse(src.slice(last));
  return blocks;
}

const CodeBlock = React.memo(function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="md-codeblock">
      <div className="md-codehead">
        <span>{lang}</span>
        <button onClick={copy} className="md-copy" aria-label="Copy code">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
});

export const MessageBody = React.memo(function MessageBody({ content }: { content: string }) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  return (
    <div className="md-root">
      {blocks.map((b) =>
        b.code !== undefined ? (
          <CodeBlock key={b.key} code={b.code} lang={b.lang ?? "code"} />
        ) : (
          <div key={b.key} dangerouslySetInnerHTML={{ __html: b.html ?? "" }} />
        )
      )}
    </div>
  );
});
