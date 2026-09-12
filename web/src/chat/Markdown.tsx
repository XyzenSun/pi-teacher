import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { markdownRehypePlugins, markdownRemarkPlugins, normalizeDisplayMath } from "../lib/markdown.ts";

/** 超过此长度的 Markdown 退化为纯文本：remark 解析超长文本会卡死主线程（pi-web 结论）。 */
export const MAX_MARKDOWN_CHARS = 100_000;

let mermaidModule: Promise<typeof import("mermaid")> | null = null;
function loadMermaid() {
  mermaidModule ??= import("mermaid").then((module) => {
    module.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", fontFamily: "Inter, sans-serif" });
    return module;
  });
  return mermaidModule;
}

let mermaidCounter = 0;

function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${++mermaidCounter}`);
  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailure(null);
    loadMermaid().then(async ({ default: mermaid }) => {
      try {
        const result = await mermaid.render(idRef.current, code);
        if (!cancelled) setSvg(result.svg);
      } catch (cause) {
        if (!cancelled) setFailure(cause instanceof Error ? cause.message : "Mermaid 渲染失败");
      }
    }).catch(() => { if (!cancelled) setFailure("Mermaid 加载失败"); });
    return () => { cancelled = true; };
  }, [code]);
  if (failure) return <pre className="!bg-error-container !text-on-error-container text-[12px]">{code}{"\n\n"}{failure}</pre>;
  if (!svg) return <div className="text-[12px] text-muted py-2">正在渲染图表…</div>;
  // mermaid 以 securityLevel=strict 渲染，输出的 SVG 已转义脚本与外链。
  return <div className="mermaid-block my-2 flex justify-center" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const language = /language-(\w+)/.exec(className ?? "")?.[1];
  const code = String(children ?? "").replace(/\n$/, "");
  const [copied, setCopied] = useState(false);
  if (language === "mermaid") return <MermaidBlock code={code} />;
  return (
    <div className="relative group my-2">
      <div className="absolute right-2 top-2 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        {language && <span className="text-[10px] text-[#9aa0a6] font-mono">{language}</span>}
        <button type="button" className="text-[10px] text-[#9aa0a6] hover:text-white" onClick={() => { void navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre><code className={className}>{code}</code></pre>
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...rest }) => {
    const isBlock = typeof className === "string" && className.startsWith("language-") || String(children ?? "").includes("\n");
    if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>;
    return <code className={className} {...rest}>{children}</code>;
  },
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
};

function PlainTextFallback({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <div className="text-[12px] text-muted mb-1">内容超过 {MAX_MARKDOWN_CHARS.toLocaleString()} 字符，已按纯文本显示。</div>
      <pre className="!bg-surface-container-low !text-on-surface whitespace-pre-wrap break-words max-h-[400px] overflow-auto" style={expanded ? { maxHeight: "none" } : undefined}>
        {expanded ? text : text.slice(0, 20_000)}
      </pre>
      {!expanded && <button type="button" className="btn-ghost text-[12px] mt-1" onClick={() => setExpanded(true)}>展开全部</button>}
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const normalized = useMemo(() => (text.length > MAX_MARKDOWN_CHARS ? null : normalizeDisplayMath(text)), [text]);
  if (normalized === null) return <PlainTextFallback text={text} />;
  return (
    <div className="prose-chat break-words">
      <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={components}>
        {normalized}
      </ReactMarkdown>
    </div>
  );
});
