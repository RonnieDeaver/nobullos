/**
 * Ads OS · Search Term Analyzer chooser (/ads-os/a/{cid}/analyzer) — port of
 * the bundle's frontend/src/components/AnalyzerChooser.tsx.
 *
 * NoBull OS adaptation: the bundle switched modes via component state
 * (onPick); here each mode is its own route, so the two cards are links to
 * ./analyzer/negatives and ./analyzer/keywords. The CID comes from the wouter
 * route and the header name resolves best-effort from the monitored-accounts
 * list (the tools themselves carry account_name in their reports).
 */

import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import { api } from "./lib/api";
import { formatId } from "./lib/format";
import { AdsOsShell } from "./components/AdsOsShell";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { Icon } from "./components/Icon";

export default function AnalyzerChooserPage() {
  const [, params] = useRoute("/ads-os/a/:cid/analyzer");
  const cid = params?.cid ?? "";
  const [accountName, setAccountName] = useState<string | null>(null);

  useEffect(() => {
    api
      .monitoredAccounts()
      .then((accts) => {
        const a = accts.find((x) => x.customer_id === cid);
        if (a) setAccountName(a.descriptive_name);
      })
      .catch(() => {}); // header falls back to the formatted CID
  }, [cid]);

  const name = accountName ?? formatId(cid);

  return (
    <AdsOsShell>
      <div className="report" data-testid="page-ads-os-analyzer">
        <Breadcrumbs view="analyzer" account={{ customer_id: cid, descriptive_name: name }} />
        <div className="report-top">
          <div className="report-title">
            <h2>{name}</h2>
            <span className="muted">{formatId(cid)} · Search Term Analyzer</span>
          </div>
        </div>

        <div className="chooser">
          <Link
            href={`/ads-os/a/${cid}/analyzer/negatives`}
            className="chooser-card"
            data-testid="link-analyzer-negatives"
          >
            <span className="chooser-emoji"><Icon name="ban" size={26} /></span>
            <span className="chooser-title">Negative Keywords</span>
            <span className="chooser-desc">
              Find wasted spend and get paste-ready negative keywords to add.
            </span>
          </Link>
          <Link
            href={`/ads-os/a/${cid}/analyzer/keywords`}
            className="chooser-card"
            data-testid="link-analyzer-keywords"
          >
            <span className="chooser-emoji"><Icon name="sparkle" size={26} /></span>
            <span className="chooser-title">New Keywords</span>
            <span className="chooser-desc">
              Find top-converting search terms to add as keywords.
            </span>
          </Link>
        </div>
      </div>
    </AdsOsShell>
  );
}
