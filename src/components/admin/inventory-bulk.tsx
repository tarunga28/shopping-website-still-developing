"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  BULK_INVENTORY_OPERATIONS,
  bulkInventoryPhrase,
  type BulkInventoryOperation,
} from "@/lib/catalog-rules";
import { bulkInventoryAction } from "@/server/actions/catalog-actions";

export interface BulkInventoryTarget {
  productId: string;
  variantId: string;
  sku: string;
}

/**
 * Bulk stock adjustment.
 *
 * Mirrors the product list's bulk bar: select rows, choose an operation, type a
 * confirmation phrase that names both the operation and the count, then apply.
 * The typed phrase is not decoration — a misplaced digit in a quantity field is
 * the easiest way to put a hundred variants out by a factor of ten, and the
 * mistake otherwise surfaces much later as oversold orders.
 */
export function InventoryBulkBar({ targets }: { targets: BulkInventoryTarget[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [operation, setOperation] = useState<BulkInventoryOperation>("STOCK_IN");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const selectedTargets = useMemo(
    () => targets.filter((target) => selected.includes(target.variantId)),
    [targets, selected],
  );
  const phrase = selectedTargets.length ? bulkInventoryPhrase(operation, selectedTargets.length) : "";
  const allSelected = targets.length > 0 && selectedTargets.length === targets.length;

  function toggle(variantId: string, checked: boolean) {
    setSelected((current) =>
      checked ? [...new Set([...current, variantId])] : current.filter((item) => item !== variantId),
    );
  }

  return (
    <div className="rounded-card border-[1.5px] border-clay p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-sm font-bold uppercase">Bulk stock change</h2>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="size-4"
            checked={allSelected}
            onChange={(event) =>
              setSelected(event.target.checked ? targets.map((target) => target.variantId) : [])
            }
          />
          Select all {targets.length} on this page
        </label>
      </div>

      <form
        className="mt-3 grid gap-3"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData();
          form.set("operation", operation);
          form.set("quantity", quantity);
          form.set("reason", reason);
          form.set("referenceType", "MANUAL");
          form.set("confirmation", confirmation);
          for (const target of selectedTargets) {
            form.append("targets", `${target.productId}:${target.variantId}`);
          }
          const result = await bulkInventoryAction(null, form);
          setMessage(result.ok ? result.message ?? "Updated." : result.error);
          if (result.ok) {
            setSelected([]);
            setConfirmation("");
            router.refresh();
          }
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={operation}
            onChange={(event) => setOperation(event.target.value as BulkInventoryOperation)}
            className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm"
            aria-label="Operation"
          >
            {BULK_INVENTORY_OPERATIONS.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
          <input
            type="number"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            className="h-9 w-24 rounded-full border-[1.5px] border-clay px-3 text-sm tabular-nums"
            aria-label="Quantity per variant"
            title="Applied to each selected variant, not split across them"
          />
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (required)"
            required
            className="h-9 w-56 rounded-full border-[1.5px] border-clay px-3 text-sm"
            aria-label="Reason"
          />
        </div>

        <p className="text-xs text-smoke">
          {selectedTargets.length === 0
            ? "No variants selected."
            : `The quantity is applied to each of the ${selectedTargets.length} selected variant${
                selectedTargets.length === 1 ? "" : "s"
              } separately — it is not divided between them. Every movement is written to the ledger.`}
        </p>

        {selectedTargets.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-smoke">Type to confirm:</span>
            <code className="rounded bg-sand px-2 py-1 font-mono text-xs">{phrase}</code>
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className="h-9 w-44 rounded-full border-[1.5px] border-clay px-3 font-mono text-xs"
              aria-label="Confirmation phrase"
              placeholder={phrase}
            />
          </div>
        ) : null}

        <Button type="submit" size="sm" disabled={selectedTargets.length === 0}>
          Apply to {selectedTargets.length}
        </Button>

        {message ? (
          <p role="status" className="text-sm">
            {message}
          </p>
        ) : null}
      </form>

      {targets.length > 0 ? (
        <ul className="mt-3 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {targets.map((target) => (
            <li key={target.variantId}>
              <label className="flex items-center gap-2 font-mono text-xs">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={selected.includes(target.variantId)}
                  onChange={(event) => toggle(target.variantId, event.target.checked)}
                />
                {target.sku}
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
