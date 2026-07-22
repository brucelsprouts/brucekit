import { useEffect, useState } from "react";
import type { ToolContext } from "../types";
import type { Clip } from "../../core/ipc";

/**
 * The preview for one image clip.
 *
 * The bytes come over IPC per clip rather than inside the list payload: a
 * screen's worth of rows would otherwise ship megabytes of base64 on every
 * refresh, and refreshes happen on every copy. Rust hands back a small
 * pre-scaled PNG, which the browser then draws inside a fixed box (see
 * `.bk-clip__thumb`), so a copied 4K screenshot and a copied favicon take up
 * the same amount of room in the list.
 *
 * The object URL is revoked on unmount; the list keys rows by clip id, so a
 * row that survives a refresh keeps its already-fetched image.
 */
export function ClipThumb({ ctx, clip }: { ctx: ToolContext; clip: Clip }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;

    ctx
      .invoke("clips_image", { id: clip.id })
      .then((bytes) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        setUrl(objectUrl);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });

    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [ctx, clip.id]);

  if (failed) {
    return <span className="bk-clip__thumb bk-clip__thumb--missing">?</span>;
  }
  if (!url) {
    // Reserves the row height so the list doesn't jump as previews land.
    return <span className="bk-clip__thumb bk-clip__thumb--loading" />;
  }
  // Decorative: the row's own label already announces the clip and its size,
  // and there is nothing truthful to say about a picture we never looked at.
  return <img className="bk-clip__thumb" src={url} alt="" draggable={false} />;
}
