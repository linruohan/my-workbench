import { fileExtension, isImageFile, isMarkdownFile } from "@wb/domain";
import {
  IconDatabase,
  IconFile,
  IconFileCode,
  IconFolder,
  IconFolderOpen,
} from "../shell/icons";

export function FolderIcon({ open }: { open: boolean }) {
  const Icon = open ? IconFolderOpen : IconFolder;
  return (
    <span className="knowledge__icon knowledge__icon--folder" aria-hidden>
      <Icon size={14} />
    </span>
  );
}

export function FileIcon({ name }: { name: string }) {
  const ext = fileExtension(name);
  if (isMarkdownFile(name)) {
    return (
      <span className="knowledge__icon knowledge__icon--md" aria-hidden title="Markdown">
        MD
      </span>
    );
  }
  if (ext === "css" || ext === "scss" || ext === "less") {
    return (
      <span className="knowledge__icon knowledge__icon--css" aria-hidden title={ext}>
        css
      </span>
    );
  }
  if (ext === "json" || ext === "jsonc" || ext === "json5") {
    return (
      <span className="knowledge__icon knowledge__icon--json" aria-hidden title="JSON">
        <IconDatabase size={13} />
      </span>
    );
  }
  if (
    ext === "js" ||
    ext === "jsx" ||
    ext === "ts" ||
    ext === "tsx" ||
    ext === "mjs" ||
    ext === "cjs"
  ) {
    return (
      <span
        className={`knowledge__icon knowledge__icon--code knowledge__icon--${ext === "ts" || ext === "tsx" ? "ts" : "js"}`}
        aria-hidden
      >
        <IconFileCode size={13} />
      </span>
    );
  }
  if (ext === "html" || ext === "htm" || ext === "xml" || ext === "svg") {
    return (
      <span className="knowledge__icon knowledge__icon--html" aria-hidden>
        <IconFileCode size={13} />
      </span>
    );
  }
  if (isImageFile(name)) {
    return (
      <span className="knowledge__icon knowledge__icon--image" aria-hidden>
        <IconFile size={13} />
      </span>
    );
  }
  if (ext === "py") {
    return (
      <span className="knowledge__icon knowledge__icon--py" aria-hidden>
        <IconFileCode size={13} />
      </span>
    );
  }
  if (ext === "rs") {
    return (
      <span className="knowledge__icon knowledge__icon--rs" aria-hidden>
        <IconFileCode size={13} />
      </span>
    );
  }
  if (ext === "yml" || ext === "yaml" || ext === "toml") {
    return (
      <span className="knowledge__icon knowledge__icon--data" aria-hidden>
        <IconFile size={13} />
      </span>
    );
  }
  return (
    <span className="knowledge__icon knowledge__icon--file" aria-hidden>
      <IconFile size={13} />
    </span>
  );
}
