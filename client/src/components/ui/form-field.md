# FormField — inline validation standard

Task #4346 (audit P1-8, §8.3). `FormField` is the standard wrapper for a
labeled form control: **label + control + helper text + inline error**, styled
with design tokens (`text-destructive`, `text-muted-foreground`).

## The standard

- **Field validation is inline.** Invalid input renders an error line under
  the control (destructive token color, `role="alert"`), and the control gets
  `aria-invalid` + `aria-describedby`. Models: `client/src/pages/ClientAdd.tsx`,
  `client/src/pages/ReportForm.tsx`.
- **Toasts are reserved for async side-effect results** — a save that failed
  on the server, a background job that finished. Never toast field
  validation. The global query-client handler
  (`client/src/lib/queryClient.ts` + `client/src/lib/queryErrorCopy.ts`)
  already translates async failures (rate-limit, offline, auth expired,
  server error…) into humane copy with recovery guidance; component code
  should not re-toast those.
- Existing forms migrate opportunistically as their modules are touched —
  new/edited fields use `FormField`.

## Anatomy & props

```tsx
<FormField
  label="Backoff minutes"          // visible label
  htmlFor="input-backoff-minutes"  // control id; derives error/helper ids
  required                          // destructive asterisk after the label
  helper="0 disables backoff."     // optional muted line under the control
  error={errors.backoff}            // falsy = valid; string/node = inline error
>
  <Input type="number" … />
</FormField>
```

- `error` falsy → nothing renders; truthy → `<p role="alert"
  data-testid="error-<htmlFor>">` under the field (override via
  `errorTestId`).
- A single element child automatically receives `id` (from `htmlFor`),
  `aria-invalid`, and `aria-describedby` (helper + error ids, merged with any
  existing value).

## Composite / Radix controls — render function

Radix roots (Select, Popover triggers…) don't take DOM attributes on the root
element. Use the render-function form and spread the context where it belongs:

```tsx
<FormField label="Client" htmlFor="select-client" error={errors.client}>
  {(ctx) => (
    <Select value={clientId} onValueChange={setClientId}>
      <SelectTrigger
        id={ctx.fieldId}
        aria-invalid={ctx.invalid}
        aria-describedby={ctx.describedBy}
      >
        <SelectValue placeholder="Choose a client" />
      </SelectTrigger>
      <SelectContent>…</SelectContent>
    </Select>
  )}
</FormField>
```

## Validate-on-submit pattern

Compute an errors object in the submit handler, store it in state, and clear
each field's entry on change — no toast:

```tsx
const [errors, setErrors] = useState<{ budget?: string }>({});

function save() {
  const next: typeof errors = {};
  if (!Number.isInteger(budget) || budget < 1) {
    next.budget = "Enter a whole number of 1 or more.";
  }
  setErrors(next);
  if (Object.keys(next).length > 0) return; // inline errors are showing
  mutation.mutate({ budget });               // async result MAY toast
}
```

Proof adopters: `client/src/components/comms/ReminderDialog.tsx`,
`client/src/pages/admin/FeedbackAdmin.tsx` (retry tuning).
