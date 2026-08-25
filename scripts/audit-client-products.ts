/**
 * One-shot audit (Task #656): list any client rows whose `products` column
 * contains values that would now be rejected by the strict
 * `validateProductList` check at the API boundary. These are rows whose
 * unknown product values were silently dropped under the previous
 * `normalizeProductList`-only behavior.
 *
 * Run:
 *   npx tsx scripts/audit-client-products.ts
 *
 * The script is read-only — it does NOT mutate any client rows. It prints
 * a tab-separated report of: client_id, client_code, firm_name,
 * stored_products, invalid_values.
 */
import { db } from "../server/db";
import { clients } from "../shared/schema";
import { validateProductList } from "../shared/productResolution";

async function main(): Promise<void> {
  const rows = await db
    .select({
      id: clients.id,
      clientCode: clients.clientCode,
      firmName: clients.firmName,
      products: clients.products,
    })
    .from(clients);

  const offenders: Array<{
    id: string;
    clientCode: string | null;
    firmName: string;
    stored: string[];
    invalid: string[];
  }> = [];
  for (const r of rows) {
    const stored = Array.isArray(r.products) ? r.products : [];
    const { invalid } = validateProductList(stored);
    if (invalid.length > 0) {
      offenders.push({
        id: r.id,
        clientCode: r.clientCode,
        firmName: r.firmName,
        stored,
        invalid,
      });
    }
  }

  console.log(
    `client_id\tclient_code\tfirm_name\tstored_products\tinvalid_values`,
  );
  for (const o of offenders) {
    console.log(
      [
        o.id,
        o.clientCode ?? "",
        o.firmName,
        JSON.stringify(o.stored),
        JSON.stringify(o.invalid),
      ].join("\t"),
    );
  }
  console.error(
    `\n[audit-client-products] scanned ${rows.length} client(s); ` +
      `${offenders.length} have invalid product values.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[audit-client-products] FAILED", err);
  process.exit(1);
});
