import { PageDef, titleBand } from "../html";
import {
  BOOK_FUNNEL_POLICY_MANIFEST,
  type BookFunnelPolicyRecord,
} from "../../../shared/bookCommerceLaunch";

function policyMeta(policy: BookFunnelPolicyRecord): string {
  const version = policy.version ?? "not assigned";
  const status =
    policy.approvalStatus === "approved"
      ? "Owner and counsel approved"
      : policy.approvalStatus === "legacy_unverified"
        ? "Legacy notice — not approved for paid book checkout"
        : "Approval pending — paid book checkout is unavailable";
  return `<aside class="legal-policy-meta" data-policy-key="${policy.key}" data-policy-version="${version}">
    <p><strong>Version:</strong> ${version}</p>
    <p><strong>Status:</strong> ${status}</p>
  </aside>`;
}

function unavailablePolicyBody(policy: BookFunnelPolicyRecord): string {
  return `<p>No owner/counsel-approved ${policy.title.toLowerCase()} is currently published for the paid book funnel. Paid checkout remains unavailable until an approved, versioned policy is published.</p>
<p>For a question before purchase, contact NoBull Marketing through the site contact form.</p>`;
}

function legalPolicyPage(input: {
  path: string;
  policy: BookFunnelPolicyRecord;
  bodyHtml?: string;
  legacyTitle?: boolean;
  /** Points <link rel="canonical"> at a different URL than this page's own
      path — used for legacy duplicate-content URLs that must keep
      resolving without being treated as the canonical version. */
  canonicalPath?: string;
}): PageDef {
  const { policy } = input;
  const heading = input.legacyTitle
    ? "Terms of Use/Privacy Policy for NoBull Marketing, LLC"
    : policy.title;
  return {
    path: input.path,
    title: `${policy.title} - NoBull Marketing`,
    desc: `${policy.title} for NoBull Marketing, LLC.`,
    priority: "0.3",
    canonicalPath: input.canonicalPath,
    render: (r) => `
${titleBand(heading, undefined, { eyebrow: "The Fine Print" })}

<section class="legal">
  <div class="container">
    <div class="prose">
      ${policyMeta(policy)}
      ${(input.bodyHtml ?? unavailablePolicyBody(policy)).replace(/__UPLOADS__\//g, `${r}assets/uploads/`)}
    </div>
  </div>
</section>`,
  };
}

export function privacyPage(bodyHtml: string): PageDef {
  return legalPolicyPage({
    path: "privacy-policy/",
    policy: BOOK_FUNNEL_POLICY_MANIFEST.privacy,
    bodyHtml,
    legacyTitle: true,
    // Legacy URL: must keep resolving (docs/DO_NOT_BREAK.md §1) but is
    // byte-identical duplicate content of privacy/ — point search engines
    // at the canonical URL the manifest already names as authoritative.
    canonicalPath: BOOK_FUNNEL_POLICY_MANIFEST.privacy.canonicalPath ?? undefined,
  });
}

export function privacyCanonicalPage(bodyHtml: string): PageDef {
  return legalPolicyPage({
    path: "privacy/",
    policy: BOOK_FUNNEL_POLICY_MANIFEST.privacy,
    bodyHtml,
  });
}

export const termsPage = legalPolicyPage({
  path: "terms/",
  policy: BOOK_FUNNEL_POLICY_MANIFEST.terms,
});

export const shippingReturnsPage = legalPolicyPage({
  path: "shipping-returns/",
  policy: BOOK_FUNNEL_POLICY_MANIFEST.shippingReturns,
});

export const unsubscribePage: PageDef = {
  path: "unsubscribe/",
  title: "Unsubscribe - NoBull Marketing",
  desc: "Unsubscribe from NoBull Marketing communications.",
  priority: "0.1",
  render: () => `
${titleBand("Unsubscribe", undefined, { eyebrow: "Email Preferences" })}

<section class="unsub">
  <div class="container">
    <p class="lede">Please enter your email address to unsubscribe from all NoBull Marketing communications via email.</p>
    <form class="unsub-form contact-form" data-nb-inquiry="unsubscribe" data-success="You\u2019ve been unsubscribed. Our team will process your request shortly." novalidate>
      <div class="hp-field" aria-hidden="true">
        <label>Leave this field empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
      </div>
      <input type="email" name="email" placeholder="Email Address*" required autocomplete="email" maxlength="320">
      <div class="form-actions">
        <button class="btn" type="submit">Unsubscribe Me</button>
      </div>
      <div class="form-msg" data-nb-form-msg role="status"></div>
    </form>
  </div>
</section>`,
};

export const notFoundPage: PageDef = {
  path: "",
  rOverride: "{{BASE}}",
  title: "Page Not Found - NoBull Marketing",
  desc: "The page you are looking for could not be found.",
  render: (r) => `
<section class="nf">
  <div class="container">
    <h1>Page Not Found</h1>
    <p>The page you\u2019re looking for doesn\u2019t exist or may have moved. Head back to the homepage to keep exploring.</p>
    <a class="btn" href="${r}">Back to Homepage</a>
  </div>
</section>`,
};
