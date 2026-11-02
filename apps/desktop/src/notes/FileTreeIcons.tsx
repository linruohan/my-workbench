import type { ReactNode } from "react";
import { fileExtension, isImageFile, isMarkdownFile, isTextFile } from "@wb/domain";

/**
 * Mac / Finder–style solid icons for the knowledge file tree.
 * Visual language inspired by vscode-icons (MIT) and macOS folder chrome:
 * filled shapes, warm folder yellow, distinct per-type colors.
 */

type SvgProps = { size?: number; className?: string; title?: string };

function IconSvg({
  size = 16,
  className,
  title,
  children,
}: SvgProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/** Solid macOS Finder–style folder (closed). */
function MacFolderClosed({ size = 16 }: SvgProps) {
  return (
    <IconSvg size={size} title="文件夹">
      {/* body */}
      <path
        fill="#F2CB6A"
        d="M1.25 5.1c0-.72.58-1.3 1.3-1.3h3.05l.55.7c.12.15.3.24.5.24h6.8c.72 0 1.3.58 1.3 1.3v7.15c0 .72-.58 1.3-1.3 1.3H2.55c-.72 0-1.3-.58-1.3-1.3Z"
      />
      {/* tab + top lip */}
      <path
        fill="#E0B04A"
        d="M1.25 4.55c0-.72.58-1.3 1.3-1.3h2.7l.85 1.05h7.35c.72 0 1.3.58 1.3 1.3v.85H1.25Z"
      />
      {/* soft highlight */}
      <path fill="#F8DE9A" fillOpacity="0.55" d="M2.2 6.35h11.2v1.15H2.2Z" />
    </IconSvg>
  );
}

/** Solid macOS Finder–style folder (open). */
function MacFolderOpen({ size = 16 }: SvgProps) {
  return (
    <IconSvg size={size} title="打开的文件夹">
      {/* back panel / tab */}
      <path
        fill="#F6D78A"
        d="M1.35 4c0-.6.48-1.1 1.08-1.1h2.85l.9 1.05h6.95c.6 0 1.08.5 1.08 1.1v1.85H1.35Z"
      />
      {/* front flap */}
      <path
        fill="#E0B04A"
        d="M1.1 6.85h13.35l-1.2 5.7c-.12.58-.63 1-1.22 1H3.52c-.6 0-1.1-.42-1.22-1Z"
      />
      {/* inner paper hint */}
      <path fill="#FFF6DE" d="M3.1 5.55h9.3v1.65H3.1Z" />
    </IconSvg>
  );
}

function DocShell({
  fill,
  fold = "#fff",
  children,
  size,
  title,
}: SvgProps & { fill: string; fold?: string; children?: ReactNode }) {
  return (
    <IconSvg size={size} title={title}>
      <path
        fill={fill}
        d="M3.2 1.5h6.1L12.8 5v9.3A1.2 1.2 0 0 1 11.6 15.5H3.2A1.2 1.2 0 0 1 2 14.3V2.7A1.2 1.2 0 0 1 3.2 1.5Z"
      />
      <path fill={fold} fillOpacity="0.35" d="M9.3 1.5V5h3.5Z" />
      {children}
    </IconSvg>
  );
}

function IconMd({ size }: SvgProps) {
  return (
    <DocShell size={size} fill="#4B8BBE" title="Markdown">
      <path
        fill="#fff"
        d="M4.1 10.8V5.6h1.35l1.25 2.1 1.25-2.1H9.3v5.2H8.05V7.7L6.7 9.85 5.35 7.7v3.1Zm6.2 0L8.45 8h1.2V5.6h1.35V8h1.2Z"
      />
    </DocShell>
  );
}

function IconJs({ size }: SvgProps) {
  return (
    <DocShell size={size} fill="#F0DB4F" fold="#E6C200" title="JavaScript">
      <path
        fill="#323330"
        d="M6.1 10.9c.2.4.45.7.95.7.45 0 .75-.2.75-.65 0-.4-.25-.55-.85-.8l-.3-.12c-.85-.35-1.4-.8-1.4-1.75 0-.9.7-1.55 1.75-1.55.9 0 1.45.3 1.85.95l-.9.55c-.2-.3-.4-.5-.75-.5-.35 0-.55.2-.55.5 0 .35.2.5.7.7l.3.12c1 .4 1.55.85 1.55 1.8 0 1.05-.8 1.65-1.95 1.65-1.05 0-1.75-.45-2.15-1.15Zm-2.35.05c.2.4.4.7.85.7.4 0 .65-.15.65-.75V5.55h1.2v4.5c0 1.3-.7 1.9-1.8 1.9-.8 0-1.35-.35-1.7-.9Z"
      />
    </DocShell>
  );
}

function IconTs({ size }: SvgProps) {
  return (
    <DocShell size={size} fill="#3178C6" title="TypeScript">
      <path
        fill="#fff"
        d="M4.2 6.1h7.1v1.15H8.85v5.1H7.55v-5.1H4.2Zm5.55 2.35c.55 0 .95.15 1.25.5.15.2.25.45.25.85 0 .7-.4 1.15-1.2 1.35l.95 1.55h-1.25l-.75-1.3h-.35v1.3H7.5V8.45Zm1.05 1.1h-.4v1.05h.4c.35 0 .55-.15.55-.5s-.2-.55-.55-.55Z"
      />
    </DocShell>
  );
}

function IconCss({ size }: SvgProps) {
  return (
    <DocShell size={size} fill="#563D7C" title="CSS">
      <path
        fill="#fff"
        d="M5.1 10.9V7.55h1.55c.85 0 1.35.4 1.35 1.15S7.45 9.8 6.65 9.8H6.2v1.1Zm1.1-2.15h.35c.3 0 .45-.15.45-.4s-.15-.4-.45-.4h-.35Zm2.55 2.15V7.55h1.55c.85 0 1.35.4 1.35 1.15S10.2 9.8 9.4 9.8H8.95v1.1Zm1.1-2.15h.35c.3 0 .45-.15.45-.4s-.15-.4-.45-.4h-.35Z"
      />
    </DocShell>
  );
}

function IconHtml({ size }: SvgProps) {
  return (
    <DocShell size={size} fill="#E44D26" title="HTML">
      <path
        fill="#fff"
        d="M5.2 10.9 4.35 5.7h7.3l-.85 5.2-2.8.85Zm3.55-1.05.25-2.35H7.1v-.9h2.95l.15-.95H5.8l.45 4.55 1.85.5Z"
      />
    </DocShell>
  );
}

function IconJson({ size }: SvgProps) {
  return (
    <DocShell size={size} fill="#CBCB41" fold="#B8B830" title="JSON">
      <path
        fill="#323330"
        d="M5.4 5.6c.55 0 .9.2 1.1.55l-.75.5c-.1-.15-.25-.25-.45-.25s-.4.15-.4.45v2.3c0 .3.2.45.4.45s.35-.1.45-.25l.75.5c-.2.35-.55.55-1.1.55-.85 0-1.35-.55-1.35-1.55V7.15c0-1 .5-1.55 1.35-1.55Zm5.2 0c.85 0 1.35.55 1.35 1.55v2.3c0 1-.5 1.55-1.35 1.55-.55 0-.9-.2-1.1-.55l.75-.5c.1.15.25.25.45.25s.4-.15.4-.45V7.35c0-.3-.2-.45-.4-.45s-.35.1-.45.25l-.75-.5c.2-.35.55-.55 1.1-.55Z"
      />
    </DocShell>
  );
}

function IconPy({ size }: SvgProps) {
  return (
    <DocShell size={size} fill="#3776AB" title="Python">
      <path
        fill="#FFD43B"
        d="M8.2 4.9c-1.9 0-1.8.85-1.8.85v.85h1.85v.3H5.35S4.1 6.7 4.1 8.55s1.05 1.8 1.05 1.8h.55V9.5s0-1.05 1.05-1.05h1.8s1 .05 1 .95V6.55S9.75 4.9 8.2 4.9Zm-.95.55a.35.35 0 1 1 0 .7.35.35 0 0 1 0-.7Z"
      />
      <path
        fill="#FFD43B"
        d="M7.85 11.6c1.9 0 1.8-.85 1.8-.85v-.85H7.8v-.3h2.9s1.25.2 1.25-1.65-1.05-1.8-1.05-1.8h-.55v.85s0 1.05-1.05 1.05H7.5s-1-.05-1-.95v2.85s-.15 1.65 1.85 1.65Zm.95-.55a.35.35 0 1 1 0-.7.35.35 0 0 1 0 .7Z"
      />
    </DocShell>
  );
}

function IconRs({ size }: SvgProps) {
  return (
    <DocShell size={size} fill="#DEA584" fold="#C48A6A" title="Rust">
      <circle cx="8" cy="8.2" r="3.1" fill="none" stroke="#3B2E2A" strokeWidth="1.1" />
      <circle cx="8" cy="8.2" r="1.15" fill="#3B2E2A" />
    </DocShell>
  );
}

function IconImage({ size }: SvgProps) {
  return (
    <IconSvg size={size} title="图片">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="#34D399" />
      <circle cx="5.2" cy="6" r="1.2" fill="#fff" />
      <path fill="#fff" d="M3 12.2 6.4 7.8l2.2 2.5 1.7-2.1L13 12.2Z" />
    </IconSvg>
  );
}

function IconPdf({ size }: SvgProps) {
  return (
    <DocShell size={size} fill="#E5252A" title="PDF">
      <path
        fill="#fff"
        d="M4.4 10.9V5.7h2.1c.85 0 1.45.45 1.45 1.25 0 .55-.3.95-.75 1.15L8.7 10.9H7.35l-1.2-2.45H5.55v2.45Zm1.15-3.45h.85c.35 0 .55-.2.55-.5s-.2-.5-.55-.5h-.85Z"
      />
    </DocShell>
  );
}

function IconYaml({ size }: SvgProps) {
  return (
    <DocShell size={size} fill="#CB171E" title="YAML">
      <path
        fill="#fff"
        d="M4.6 5.6h1.3l1.1 2.55 1.1-2.55h1.3L7.35 10.9H6.05Zm5.4 0h1.2v5.3H9.9V8.55l-.95 1.35h-.9l-.95-1.35v2.35H5.95V5.6h1.2l1.25 1.9Z"
      />
    </DocShell>
  );
}

function IconXml({ size }: SvgProps) {
  return (
    <DocShell size={size} fill="#F16529" title="XML">
      <path
        fill="#fff"
        d="M5.1 10.5 3.4 8.2 5.1 5.9h1.35L4.9 8.2l1.55 2.3Zm5.8 0h-1.35l1.55-2.3-1.55-2.3H11L12.7 8.2 11 10.5Zm-2.55.2-.55-5.6h1.25l.55 5.6Z"
      />
    </DocShell>
  );
}

function IconText({ size }: SvgProps) {
  return (
    <DocShell size={size} fill="#A8B4C4" fold="#8E9BB0" title="文本">
      <path
        fill="#4A5568"
        d="M4.4 6.1h7.2v1.05H4.4Zm0 2.2h7.2v1.05H4.4Zm0 2.2h5.2V11.55H4.4Z"
      />
    </DocShell>
  );
}

function IconDefaultFile({ size }: SvgProps) {
  return (
    <DocShell size={size} fill="#C5C5C5" fold="#E8E8E8" title="文件">
      <path fill="#8A8A8A" d="M4.5 7h7v1H4.5Zm0 2.2h7v1H4.5Zm0 2.2h5v1h-5Z" />
    </DocShell>
  );
}

function IconShell({ size }: SvgProps) {
  return (
    <DocShell size={size} fill="#4EAA25" title="Shell">
      <path
        fill="#fff"
        d="M4.4 6.1 6.7 8.2 4.4 10.3l.9.9 3-2.9-3-2.9Zm3.6 4.1h3.8v1.15H8Z"
      />
    </DocShell>
  );
}

function IconToml({ size }: SvgProps) {
  return (
    <DocShell size={size} fill="#9C4221" title="TOML">
      <path
        fill="#fff"
        d="M4.5 5.7h7v1.15H8.85v4.9H7.15v-4.9H4.5Z"
      />
    </DocShell>
  );
}

export function FolderIcon({ open }: { open: boolean }) {
  return (
    <span className="knowledge__icon knowledge__icon--folder" aria-hidden>
      {open ? <MacFolderOpen /> : <MacFolderClosed />}
    </span>
  );
}

export function FileIcon({ name }: { name: string }) {
  const ext = fileExtension(name);
  let node: ReactNode;
  let kind = "file";

  if (isMarkdownFile(name)) {
    node = <IconMd />;
    kind = "md";
  } else if (ext === "css" || ext === "scss" || ext === "less") {
    node = <IconCss />;
    kind = "css";
  } else if (ext === "html" || ext === "htm") {
    node = <IconHtml />;
    kind = "html";
  } else if (ext === "xml" || ext === "xsl" || ext === "svg") {
    node = ext === "svg" ? <IconImage /> : <IconXml />;
    kind = ext === "svg" ? "image" : "xml";
  } else if (ext === "json" || ext === "jsonc" || ext === "json5") {
    node = <IconJson />;
    kind = "json";
  } else if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") {
    node = <IconJs />;
    kind = "js";
  } else if (ext === "ts" || ext === "tsx" || ext === "mts" || ext === "cts") {
    node = <IconTs />;
    kind = "ts";
  } else if (ext === "py" || ext === "pyw" || ext === "pyi") {
    node = <IconPy />;
    kind = "py";
  } else if (ext === "rs") {
    node = <IconRs />;
    kind = "rs";
  } else if (isImageFile(name)) {
    node = <IconImage />;
    kind = "image";
  } else if (ext === "pdf") {
    node = <IconPdf />;
    kind = "pdf";
  } else if (ext === "yml" || ext === "yaml") {
    node = <IconYaml />;
    kind = "yaml";
  } else if (ext === "toml") {
    node = <IconToml />;
    kind = "toml";
  } else if (
    ext === "sh" ||
    ext === "bash" ||
    ext === "zsh" ||
    ext === "ps1" ||
    ext === "bat" ||
    ext === "cmd"
  ) {
    node = <IconShell />;
    kind = "shell";
  } else if (isTextFile(name) || ext === "txt" || ext === "log" || ext === "csv") {
    node = <IconText />;
    kind = "text";
  } else {
    node = <IconDefaultFile />;
  }

  return (
    <span className={`knowledge__icon knowledge__icon--${kind}`} aria-hidden>
      {node}
    </span>
  );
}
