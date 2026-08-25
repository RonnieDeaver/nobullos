import {
  CANONICAL_PRODUCTS,
  CLIENT_PRODUCT_OPTIONS,
} from "@shared/productResolution";

export class ClientSaveError extends Error {
  description?: string;
  code?: string;
  invalidProducts?: string[];
  allowedProducts?: string[];

  constructor(
    message: string,
    opts?: {
      description?: string;
      code?: string;
      invalidProducts?: string[];
      allowedProducts?: string[];
    },
  ) {
    super(message);
    this.name = "ClientSaveError";
    this.description = opts?.description;
    this.code = opts?.code;
    this.invalidProducts = opts?.invalidProducts;
    this.allowedProducts = opts?.allowedProducts;
  }
}

const PRODUCT_LABELS: Record<string, string> = Object.fromEntries(
  CLIENT_PRODUCT_OPTIONS.map((o) => [o.value, o.label]),
);

export function formatAllowedProducts(allowed: string[]): string {
  return allowed
    .map((v) => (PRODUCT_LABELS[v] ? `${PRODUCT_LABELS[v]} (${v})` : v))
    .join(", ");
}

export function describeInvalidProductsError(
  invalid: string[],
  allowed: string[],
): string {
  const invalidPart = invalid.length
    ? `Rejected value${invalid.length === 1 ? "" : "s"}: ${invalid
        .map((v) => `"${v}"`)
        .join(", ")}.`
    : "One or more product values were not recognized.";
  const allowedPart = `Allowed products: ${formatAllowedProducts(allowed)}.`;
  return `${invalidPart} ${allowedPart} Fix the typo, or ask an admin to add the alias to the product normalizer.`;
}

/**
 * Parse a non-OK Response from a client create/update endpoint and return a
 * `ClientSaveError` with operator-friendly title + description. Specifically
 * surfaces the `code: "INVALID_PRODUCTS"` shape from `server/routes/clients.ts`
 * with the rejected values and the canonical allow-list inline so operators
 * don't need the network tab to know what was wrong.
 */
export async function parseClientSaveError(
  res: Response,
  fallbackTitle: string,
): Promise<ClientSaveError> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // body wasn't JSON — fall through to fallback
  }

  if (body && body.code === "INVALID_PRODUCTS") {
    const invalid: string[] = Array.isArray(body.invalid)
      ? body.invalid.map((v: unknown) => String(v))
      : [];
    const allowed: string[] = Array.isArray(body.allowed) && body.allowed.length
      ? body.allowed.map((v: unknown) => String(v))
      : [...CANONICAL_PRODUCTS];
    return new ClientSaveError("Unknown product value submitted", {
      description: describeInvalidProductsError(invalid, allowed),
      code: "INVALID_PRODUCTS",
      invalidProducts: invalid,
      allowedProducts: allowed,
    });
  }

  const description =
    typeof body?.error === "string"
      ? body.error
      : body?.error
        ? JSON.stringify(body.error)
        : `HTTP ${res.status}`;
  return new ClientSaveError(fallbackTitle, { description });
}
