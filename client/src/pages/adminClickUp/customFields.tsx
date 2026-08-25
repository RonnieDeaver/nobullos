// ClickUp admin — custom-field editor + task custom-fields tab.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { useState, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { File, Loader2, Lock, SlidersHorizontal, Star, Upload, Users, X } from "lucide-react";
import type { CustomField, Task } from "./types";
import { CF_READ_ONLY, cfDisplayValue, isApplicableToTask } from "./lib";

// ─── Individual field editor ──────────────────────────────────────────────────

export function CustomFieldEditor({
  taskId,
  field,
  onRefresh,
}: {
  taskId: string;
  field: CustomField;
  onRefresh(): void;
}) {
  const { toast } = useToast();
  const isReadOnly = CF_READ_ONLY.has(field.type);
  const [editVal, setEditVal] = useState<any>(field.value ?? "");
  const [fileUploading, setFileUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const hasValue = field.value !== null && field.value !== undefined && field.value !== "";
  const pendingChange =
    !isReadOnly &&
    field.type !== "labels" &&
    field.type !== "users" &&
    field.type !== "relationship" &&
    String(editVal ?? "") !== String(field.value ?? "");

  const setMut = useMutation({
    mutationFn: async (value: any) => {
      const res = await fetch(`/api/clickup/tasks/${taskId}/fields/${field.id}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      onRefresh();
      toast({ title: `${field.name} updated` });
    },
    onError: (e: any) =>
      toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const clearMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clickup/tasks/${taskId}/fields/${field.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      setEditVal("");
      onRefresh();
      toast({ title: `${field.name} cleared` });
    },
    onError: (e: any) =>
      toast({ title: "Clear failed", description: e.message, variant: "destructive" }),
  });

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file, file.name);
      const uploadRes = await fetch(`/api/clickup/tasks/${taskId}/attachments`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      if (!uploadRes.ok) {
        const d = await uploadRes.json().catch(() => ({}));
        throw new Error(d.error ?? `Upload failed (${uploadRes.status})`);
      }
      const uploadData = await uploadRes.json();
      const attId: string = uploadData.attachment?.id ?? uploadData.id ?? uploadData.attachment_id;
      if (!attId) throw new Error("No attachment ID in upload response");
      await setMut.mutateAsync(attId);
    } catch (err: any) {
      toast({ title: "File upload failed", description: err.message, variant: "destructive" });
    } finally {
      setFileUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function handleLabelToggle(optId: string) {
    const current: string[] = Array.isArray(field.value)
      ? field.value.map((v: any) => (typeof v === "object" ? (v.id ?? "") : String(v)))
      : [];
    const next = current.includes(optId)
      ? current.filter((id) => id !== optId)
      : [...current, optId];
    setMut.mutate(next.map((id) => ({ id })));
  }

  const isBusy = setMut.isPending || clearMut.isPending || fileUploading;
  const currentLabelIds = Array.isArray(field.value)
    ? field.value.map((v: any) => (typeof v === "object" ? (v.id ?? "") : String(v)))
    : [];

  return (
    <div className="py-2 border-b last:border-b-0" data-testid={`cf-row-${field.id}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 mb-1">
            <span className="text-xs font-medium text-gray-700 truncate">{field.name}</span>
            {isReadOnly && (
              <Lock className="w-2.5 h-2.5 text-gray-400 flex-shrink-0" aria-label="Read-only (computed)" />
            )}
            {field.required && (
              <span className="text-[9px] text-red-400 font-medium flex-shrink-0">required</span>
            )}
          </div>

          {/* Read-only computed types */}
          {isReadOnly && (
            <span className="text-xs text-gray-500 italic" data-testid={`cf-value-${field.id}`}>
              {cfDisplayValue(field)}
            </span>
          )}

          {/* Checkbox */}
          {!isReadOnly && field.type === "checkbox" && (
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!!field.value}
                disabled={isBusy}
                onChange={(e) => setMut.mutate(e.target.checked)}
                className="w-4 h-4 accent-purple-600"
                data-testid={`cf-checkbox-${field.id}`}
              />
              <span className="text-xs text-gray-500">{field.value ? "Checked" : "Unchecked"}</span>
            </div>
          )}

          {/* Dropdown */}
          {!isReadOnly && field.type === "dropdown" && (
            <div className="flex items-center gap-2">
              <Select
                value={String(field.value ?? "")}
                onValueChange={(v) => setMut.mutate(v === "__clear__" ? null : v)}
                disabled={isBusy}
              >
                <SelectTrigger className="h-7 text-xs w-48" data-testid={`cf-dropdown-${field.id}`}>
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__clear__" className="text-xs text-gray-400 italic">
                    — Clear —
                  </SelectItem>
                  {(field.type_config?.options ?? []).map((opt) => (
                    <SelectItem key={opt.id} value={opt.id} className="text-xs">
                      <span className="flex items-center gap-1.5">
                        {opt.color && (
                          <span
                            className="w-2 h-2 rounded-full inline-block flex-shrink-0"
                            style={{ background: opt.color }}
                          />
                        )}
                        {opt.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Labels (multi-select) */}
          {!isReadOnly && field.type === "labels" && (
            <div className="flex flex-wrap gap-1" data-testid={`cf-labels-${field.id}`}>
              {(field.type_config?.options ?? []).map((opt) => {
                const selected = currentLabelIds.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    disabled={isBusy}
                    onClick={() => handleLabelToggle(opt.id)}
                    className={`text-[10px] px-2 py-0.5 rounded-full border font-medium transition-colors ${
                      selected
                        ? "border-purple-400 text-white"
                        : "border-gray-200 text-gray-600 bg-gray-50 hover:border-purple-300"
                    }`}
                    style={selected && opt.color ? { background: opt.color, borderColor: opt.color } : {}}
                    data-testid={`cf-label-opt-${field.id}-${opt.id}`}
                  >
                    {opt.name}
                  </button>
                );
              })}
              {(field.type_config?.options ?? []).length === 0 && (
                <span className="text-xs text-gray-400 italic">No options configured</span>
              )}
            </div>
          )}

          {/* Rating / Emoji */}
          {!isReadOnly && (field.type === "rating" || field.type === "emoji") && (
            <div className="flex items-center gap-1" data-testid={`cf-rating-${field.id}`}>
              {Array.from({ length: field.type_config?.count ?? 5 }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  disabled={isBusy}
                  onClick={() => setMut.mutate(Number(field.value) === n ? 0 : n)}
                  className="focus:outline-none"
                  data-testid={`cf-rating-star-${field.id}-${n}`}
                >
                  <Star
                    className={`w-4 h-4 transition-colors ${
                      Number(field.value) >= n ? "fill-amber-400 text-amber-400" : "text-gray-300"
                    }`}
                  />
                </button>
              ))}
              {!!field.value && (
                <span className="text-xs text-gray-400 ml-1">
                  {field.value}/{field.type_config?.count ?? 5}
                </span>
              )}
            </div>
          )}

          {/* Date */}
          {!isReadOnly && field.type === "date" && (
            <div className="flex items-center gap-2">
              <Input
                type="date"
                className="h-7 text-xs w-44"
                value={
                  field.value
                    ? new Date(Number(field.value)).toISOString().slice(0, 10)
                    : ""
                }
                disabled={isBusy}
                onChange={(e) => {
                  const d = e.target.value ? new Date(e.target.value).getTime() : null;
                  if (d !== null) setMut.mutate(d);
                }}
                data-testid={`cf-date-${field.id}`}
              />
            </div>
          )}

          {/* Number */}
          {!isReadOnly && field.type === "number" && (
            <div className="flex items-center gap-2">
              <Input
                type="number"
                className="h-7 text-xs w-32"
                value={editVal}
                disabled={isBusy}
                onChange={(e) => setEditVal(e.target.value)}
                onBlur={() => {
                  const n = parseFloat(editVal);
                  if (!isNaN(n) && String(n) !== String(field.value ?? "")) setMut.mutate(n);
                }}
                placeholder="0"
                data-testid={`cf-number-${field.id}`}
              />
            </div>
          )}

          {/* Currency */}
          {!isReadOnly && field.type === "currency" && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500">
                {field.type_config?.currency_type ?? "$"}
              </span>
              <Input
                type="number"
                className="h-7 text-xs w-32"
                value={editVal}
                disabled={isBusy}
                onChange={(e) => setEditVal(e.target.value)}
                onBlur={() => {
                  const n = parseFloat(editVal);
                  if (!isNaN(n) && String(n) !== String(field.value ?? "")) setMut.mutate(n);
                }}
                placeholder="0.00"
                data-testid={`cf-currency-${field.id}`}
              />
            </div>
          )}

          {/* Text variants */}
          {!isReadOnly &&
            ["text", "short_text", "email", "phone", "url"].includes(field.type) && (
              <div className="flex items-center gap-2">
                <Input
                  type={
                    field.type === "email"
                      ? "email"
                      : field.type === "phone"
                        ? "tel"
                        : field.type === "url"
                          ? "url"
                          : "text"
                  }
                  className="h-7 text-xs flex-1 max-w-xs"
                  value={editVal ?? ""}
                  disabled={isBusy}
                  onChange={(e) => setEditVal(e.target.value)}
                  placeholder={field.name}
                  data-testid={`cf-text-${field.id}`}
                />
                {pendingChange && (
                  <Button
                    size="sm"
                    className="h-7 text-xs px-2"
                    onClick={() => setMut.mutate(editVal || null)}
                    disabled={isBusy}
                    data-testid={`cf-save-${field.id}`}
                  >
                    {setMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
                  </Button>
                )}
              </div>
            )}

          {/* File */}
          {!isReadOnly && field.type === "file" && (
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={handleFileChange}
                data-testid={`cf-file-input-${field.id}`}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => fileRef.current?.click()}
                disabled={isBusy}
                data-testid={`cf-file-btn-${field.id}`}
              >
                {fileUploading ? (
                  <Loader2 className="w-3 h-3 animate-spin mr-1" />
                ) : (
                  <Upload className="w-3 h-3 mr-1" />
                )}
                {hasValue ? "Replace file" : "Upload file"}
              </Button>
              {hasValue && (
                <span className="text-xs text-gray-500">File attached</span>
              )}
            </div>
          )}

          {/* Relationship — linked tasks as removable chips + add-by-task-ID */}
          {!isReadOnly && field.type === "relationship" && (
            <div className="space-y-1.5" data-testid={`cf-relationship-${field.id}`}>
              <div className="flex flex-wrap gap-1">
                {(Array.isArray(field.value) ? field.value : []).map((t: any) => {
                  const tid = String(t.id ?? t);
                  const label = t.name ?? tid;
                  return (
                    <span
                      key={tid}
                      className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700"
                      data-testid={`cf-rel-chip-${field.id}-${tid}`}
                    >
                      {label}
                      <button
                        disabled={isBusy}
                        onClick={() => {
                          const next = (Array.isArray(field.value) ? field.value : [])
                            .filter((x: any) => String(x.id ?? x) !== tid)
                            .map((x: any) => String(x.id ?? x));
                          setMut.mutate(next);
                        }}
                        className="hover:text-red-500 ml-0.5"
                        data-testid={`cf-rel-remove-${field.id}-${tid}`}
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  );
                })}
                {(!Array.isArray(field.value) || (field.value as any[]).length === 0) && (
                  <span className="text-xs text-gray-400 italic">No linked tasks</span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  type="text"
                  className="h-7 text-xs w-32"
                  placeholder="Task ID"
                  value={typeof editVal === "string" ? editVal : ""}
                  onChange={(e) => setEditVal(e.target.value)}
                  disabled={isBusy}
                  data-testid={`cf-rel-add-input-${field.id}`}
                />
                <Button
                  size="sm"
                  className="h-7 text-xs px-2"
                  disabled={isBusy || !editVal}
                  onClick={() => {
                    const existing = (Array.isArray(field.value) ? field.value : []).map(
                      (x: any) => String(x.id ?? x),
                    );
                    const newId = String(editVal).trim();
                    if (!newId || existing.includes(newId)) return;
                    setMut.mutate([...existing, newId]);
                    setEditVal("");
                  }}
                  data-testid={`cf-rel-add-btn-${field.id}`}
                >
                  Add
                </Button>
              </div>
            </div>
          )}

          {/* Users — assignable user chips + add-by-user-ID */}
          {!isReadOnly && field.type === "users" && (
            <div className="space-y-1.5" data-testid={`cf-users-${field.id}`}>
              <div className="flex flex-wrap gap-1">
                {(Array.isArray(field.value) ? field.value : []).map((u: any) => {
                  const uid = String(u.id ?? u);
                  const label = u.username ?? u.email ?? uid;
                  return (
                    <span
                      key={uid}
                      className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-purple-50 border border-purple-200 text-purple-700"
                      data-testid={`cf-user-chip-${field.id}-${uid}`}
                    >
                      {label}
                      <button
                        disabled={isBusy}
                        onClick={() => {
                          const next = (Array.isArray(field.value) ? field.value : [])
                            .filter((x: any) => String(x.id ?? x) !== uid)
                            .map((x: any) => ({ id: Number(x.id ?? x) || (x.id ?? x) }));
                          setMut.mutate(next);
                        }}
                        className="hover:text-red-500 ml-0.5"
                        data-testid={`cf-user-remove-${field.id}-${uid}`}
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  );
                })}
                {(!Array.isArray(field.value) || (field.value as any[]).length === 0) && (
                  <span className="text-xs text-gray-400 italic">No users assigned</span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  type="text"
                  className="h-7 text-xs w-32"
                  placeholder="User ID"
                  value={typeof editVal === "string" ? editVal : ""}
                  onChange={(e) => setEditVal(e.target.value)}
                  disabled={isBusy}
                  data-testid={`cf-user-add-input-${field.id}`}
                />
                <Button
                  size="sm"
                  className="h-7 text-xs px-2"
                  disabled={isBusy || !editVal}
                  onClick={() => {
                    const existing = (Array.isArray(field.value) ? field.value : []).map(
                      (x: any) => ({ id: Number(x.id ?? x) || (x.id ?? x) }),
                    );
                    const rawId = String(editVal).trim();
                    if (!rawId) return;
                    const newId = Number(rawId) || rawId;
                    if (existing.some((x) => String(x.id) === rawId)) return;
                    setMut.mutate([...existing, { id: newId }]);
                    setEditVal("");
                  }}
                  data-testid={`cf-user-add-btn-${field.id}`}
                >
                  Add
                </Button>
              </div>
            </div>
          )}

          {/* Unknown type fallback */}
          {!isReadOnly &&
            ![
              "checkbox",
              "dropdown",
              "labels",
              "rating",
              "emoji",
              "date",
              "number",
              "currency",
              "text",
              "short_text",
              "email",
              "phone",
              "url",
              "file",
              "relationship",
              "users",
            ].includes(field.type) && (
              <span className="text-xs text-gray-400 italic" data-testid={`cf-value-${field.id}`}>
                {cfDisplayValue(field)} <span className="text-gray-300">({field.type})</span>
              </span>
            )}
        </div>

        {/* Clear button — only for editable fields with a set value */}
        {!isReadOnly &&
          hasValue &&
          !["labels", "checkbox", "dropdown"].includes(field.type) && (
            <button
              onClick={() => clearMut.mutate()}
              disabled={isBusy}
              className="text-gray-300 hover:text-red-400 mt-4 flex-shrink-0"
              title="Clear value"
              data-testid={`cf-clear-${field.id}`}
            >
              {clearMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
            </button>
          )}
      </div>
    </div>
  );
}

// ─── Custom fields tab ────────────────────────────────────────────────────────

export function CustomFieldsTab({
  taskId,
  customFields,
  customItemId,
  onRefresh,
}: {
  taskId: string;
  customFields: CustomField[];
  customItemId?: string | null;
  onRefresh(): void;
}) {
  const applicable = customFields.filter((f) => isApplicableToTask(f, customItemId));

  if (applicable.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-10 text-gray-400 gap-2"
        data-testid="cf-empty"
      >
        <SlidersHorizontal className="w-5 h-5" />
        <p className="text-xs">No custom fields on this task type</p>
      </div>
    );
  }

  return (
    <div className="divide-y" data-testid="panel-custom-fields">
      {applicable.map((f) => (
        <CustomFieldEditor key={f.id} taskId={taskId} field={f} onRefresh={onRefresh} />
      ))}
    </div>
  );
}

