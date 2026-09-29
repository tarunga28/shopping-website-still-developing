"use client";

import { CloudUpload, FileImage, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { cn } from "@/lib/utils";

export interface FileUploadProps {
  id?: string;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  /** Called with the selected files. Upload itself is a storage-service concern. */
  onFilesSelected: (files: File[]) => void;
  hint?: string;
  className?: string;
}

/**
 * File upload dropzone — real selection (input + drag & drop), no fake
 * progress. The storage milestone provides the upload transport; this
 * component delivers validated files via `onFilesSelected`.
 */
export function FileUpload({
  id,
  accept = "image/*",
  multiple = false,
  disabled = false,
  invalid = false,
  onFilesSelected,
  hint = "PNG, JPG or SVG up to 10 MB",
  className,
}: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);

  const commit = (incoming: FileList | File[] | null) => {
    if (!incoming?.length) return;
    const next = multiple ? [...files, ...Array.from(incoming)] : Array.from(incoming).slice(0, 1);
    setFiles(next);
    onFilesSelected(next);
  };

  const remove = (index: number) => {
    const next = files.filter((_, i) => i !== index);
    setFiles(next);
    onFilesSelected(next);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    commit(event.dataTransfer.files);
  };

  return (
    <div className={cn("w-full", className)}>
      <button
        type="button"
        id={id}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-invalid={invalid || undefined}
        className={cn(
          "flex w-full flex-col items-center justify-center gap-2 rounded-card border-[1.5px] border-dashed border-clay bg-cream/50 px-6 py-8 text-center transition-colors",
          "hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame",
          dragging && "border-flame bg-flame/10",
          invalid && "border-danger",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <CloudUpload className="size-6 text-smoke" aria-hidden />
        <span className="text-sm font-medium text-ink">
          Drop {multiple ? "files" : "a file"} here, or <span className="underline decoration-flame underline-offset-4">browse</span>
        </span>
        <span className="text-xs text-smoke">{hint}</span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          commit(event.target.files);
          event.target.value = "";
        }}
      />

      {files.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${index}`}
              className="flex items-center gap-3 rounded-card border-[1.5px] border-clay bg-cream px-4 py-2.5 text-sm"
            >
              <FileImage className="size-4 shrink-0 text-smoke" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium">{file.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-smoke">
                {(file.size / 1024).toFixed(0)} KB
              </span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => remove(index)}
                className="rounded-full p-1 text-smoke transition-colors hover:bg-sand hover:text-ink"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
