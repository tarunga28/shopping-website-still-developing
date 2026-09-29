"use client";

import Image from "next/image";
import { Camera, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { removeAvatarAction, uploadAvatarAction } from "@/server/actions/account-actions";
import { notify } from "@/lib/toast";

/**
 * Avatar manager — choose → preview → upload (validated + sniffed
 * server-side), replace or remove. URL lives on the user row.
 */
export function AvatarManager({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [selected, setSelected] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const initials = name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  function pickFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Use a JPG, PNG or WebP image.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("Keep the image under 2 MB.");
      return;
    }
    setSelected(file);
    setPreview(URL.createObjectURL(file));
  }

  async function upload() {
    if (!selected) return;
    setPending(true);
    const formData = new FormData();
    formData.set("avatar", selected);
    const result = await uploadAvatarAction(null, formData);
    if (result.ok) {
      notify.success("Profile photo updated");
      setSelected(null);
      setPreview(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      router.refresh();
    } else {
      setError(result.error);
    }
    setPending(false);
  }

  async function remove() {
    setPending(true);
    const result = await removeAvatarAction();
    if (result.ok) {
      notify.success("Profile photo removed");
      router.refresh();
    } else {
      setError(result.error);
    }
    setPending(false);
  }

  const shown = preview ?? avatarUrl;

  return (
    <section aria-labelledby="avatar-heading" className="rounded-card border-[1.5px] border-clay bg-cream p-6">
      <h2 id="avatar-heading" className="font-display text-sm font-bold uppercase tracking-tight">
        Profile photo
      </h2>

      <div className="mt-5 flex flex-wrap items-center gap-5">
        <span className="relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-pill border-[1.5px] border-ink bg-flame">
          {shown ? (
            shown.startsWith("blob:") ? (
              // Local preview before upload — plain img is intentional (not yet CDN content).
              // eslint-disable-next-line @next/next/no-img-element
              <img src={shown} alt="New profile photo preview" className="h-full w-full object-cover" />
            ) : (
              <Image src={shown} alt="Your profile photo" fill sizes="80px" className="object-cover" />
            )
          ) : (
            <span aria-hidden className="font-display text-xl font-extrabold text-on-accent">
              {initials}
            </span>
          )}
        </span>

        <div className="min-w-48 flex-1 space-y-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            aria-label="Choose profile photo"
            onChange={(event) => pickFile(event.target.files?.[0])}
          />
          {error ? <Alert variant="error">{error}</Alert> : null}
          <div className="flex flex-wrap gap-2.5">
            <Button
              variant="outline"
              size="md"
              onClick={() => fileInputRef.current?.click()}
              disabled={pending}
            >
              <Camera className="size-4" aria-hidden />
              {avatarUrl || preview ? "Choose another" : "Choose photo"}
            </Button>
            {selected ? (
              <Button variant="primary" size="md" onClick={upload} loading={pending}>
                <Upload className="size-4" aria-hidden /> Upload
              </Button>
            ) : null}
            {avatarUrl && !selected ? (
              <ConfirmDialog
                title="Remove profile photo?"
                description="Your initials will be shown instead."
                confirmLabel="Remove"
                confirmVariant="danger"
                onConfirm={remove}
                trigger={
                  <Button variant="ghost" size="md" className="text-danger hover:bg-danger/10" disabled={pending}>
                    <Trash2 className="size-4" aria-hidden /> Remove
                  </Button>
                }
              />
            ) : null}
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-smoke">
            JPG, PNG or WebP · max 2 MB · verified on the server
          </p>
        </div>
      </div>
    </section>
  );
}
