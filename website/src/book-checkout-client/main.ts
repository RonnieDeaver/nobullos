import {
  captureAttribution,
  getLatestTouchAttribution,
  getStoredAttribution,
  getOrCreateSessionId,
} from "../client-shared/attribution";

type PackageCode = "digital" | "complete";
type PublicPackage = {
  code: PackageCode;
  name: string;
  amountCents: number;
  currency: "USD";
  shippingCents: number;
};
type Address = {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};
type Totals = {
  subtotalAmountCents: number;
  discountAmountCents: number;
  shippingAmountCents: number;
  taxAmountCents: number;
  amountTotalCents: number;
  currency: string;
  quoteExpiresAt?: string | null;
};
type ResumeState = {
  packageCode: PackageCode;
  status: string;
  paymentState: string;
  contactComplete?: boolean;
  hasQuote: boolean;
  accessReady?: boolean;
  accessToken?: string | null;
};
type JourneyState = {
  applicationToken: string;
  outcome:
    | "in_progress"
    | "processing"
    | "qualified"
    | "alternate_next_step"
    | "manual_review";
  calendar: { available: boolean; url?: string };
  appointment: {
    status: string;
    scheduledAt?: string;
    endAt?: string | null;
    timezone?: string | null;
    meetingTypeName?: string | null;
    hostName?: string | null;
    meetingLink?: string | null;
  };
};
type StripeElement = {
  mount(target: string | HTMLElement): void;
  on?(event: string, callback: (payload?: Record<string, unknown>) => void): void;
  destroy?(): void;
};
type StripeElements = {
  create(type: string, options?: Record<string, unknown>): StripeElement;
  submit(): Promise<{ error?: { message?: string } }>;
};
type StripeClient = {
  elements(options: Record<string, unknown>): StripeElements;
  confirmPayment(options: Record<string, unknown>): Promise<{
    error?: { message?: string; type?: string };
    paymentIntent?: { status?: string };
  }>;
};

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeClient;
  }
}

const RESUME_KEY = "nb_book_checkout_resume_v1";
const PACKAGE_KEY = "nb_book_checkout_package_v1";
const IDEMPOTENCY_PREFIX = "nb_book_checkout_idempotency_";
const APPLICATION_TOKEN_KEY = "nb_book_buyer_application_v1";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
document.documentElement.dataset.bookMotion = reduceMotion ? "reduce" : "allow";

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function randomKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // The checkout remains usable without browser storage; refresh recovery
    // then falls back to the transactional access email.
  }
}

function removeSession(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // No-op when storage is unavailable.
  }
}

async function api<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    // Status remains authoritative even if an intermediary returned no JSON.
  }
  if (!response.ok) {
    const message =
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.error === "string"
          ? payload.error
          : "We couldn’t complete that request. Please try again.";
    throw new ApiError(response.status, message);
  }
  return payload as T;
}

function isPackage(value: unknown): value is PublicPackage {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    (item.code === "digital" || item.code === "complete") &&
    typeof item.name === "string" &&
    Number.isInteger(item.amountCents) &&
    (item.amountCents as number) >= 0 &&
    item.currency === "USD" &&
    Number.isInteger(item.shippingCents) &&
    (item.shippingCents as number) >= 0
  );
}

function checkoutAttribution(): {
  first: Record<string, string>;
  latest: Record<string, string>;
} {
  captureAttribution();
  return {
    first: getStoredAttribution(),
    latest: { ...getLatestTouchAttribution(), sessionId: getOrCreateSessionId() },
  };
}

function statusMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 410) {
    return "This secure checkout has expired. Start a new checkout to continue.";
  }
  if (error.status === 409) return error.message;
  if (error.status === 504) {
    return "The payment service took too long to respond. Nothing was submitted twice. Please try again.";
  }
  return error.message || fallback;
}

function setText(root: ParentNode, selector: string, value: string): void {
  const node = root.querySelector<HTMLElement>(selector);
  if (node) node.textContent = value;
}

function parseAddress(form: HTMLFormElement): Address {
  const data = new FormData(form);
  return {
    line1: String(data.get("line1") ?? "").trim(),
    line2: String(data.get("line2") ?? "").trim() || undefined,
    city: String(data.get("city") ?? "").trim(),
    state: String(data.get("state") ?? "").trim(),
    postalCode: String(data.get("postalCode") ?? "").trim(),
    country: String(data.get("country") ?? "US").trim().toUpperCase(),
  };
}

function clearFragment(): URLSearchParams {
  const params = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(null, "", `${location.pathname}${location.search}`);
  return params;
}

function setupResendForm(root: ParentNode): void {
  const form = root.querySelector<HTMLFormElement>("[data-delivery-resend-form]");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = String(new FormData(form).get("email") ?? "").trim();
    if (!email || !form.reportValidity()) return;
    const button = form.querySelector<HTMLButtonElement>("button");
    if (button) button.disabled = true;
    await api<{ accepted: true }>("/api/book/delivery/resend", { email }).catch(() => undefined);
    setText(
      form,
      "[data-resend-status]",
      "If an active purchase matches this address, a fresh access email is on its way.",
    );
    if (button) button.disabled = false;
  });
}

function setAccessUrl(root: ParentNode, accessToken: string): void {
  const base =
    root instanceof HTMLElement && root.dataset.accessUrl
      ? root.dataset.accessUrl
      : new URL("../access/", location.href).toString();
  const accessUrl = new URL(base, location.href);
  accessUrl.hash = `access=${encodeURIComponent(accessToken)}`;
  for (const link of root.querySelectorAll<HTMLAnchorElement>(
    "[data-access-book],[data-access-book-alt]",
  )) {
    link.href = accessUrl.toString();
    link.hidden = false;
  }
}

async function refreshAccessUrl(root: ParentNode, resumeToken: string | null): Promise<void> {
  if (!resumeToken) return;
  try {
    const state = await api<ResumeState>("/api/book/checkout/resume", { resumeToken });
    if (state.status === "completed" && state.accessToken) {
      setAccessUrl(root, state.accessToken);
    }
  } catch {
    // Access recovery remains available on the destination page and by email.
  }
}

function initCheckout(root: HTMLElement): void {
  const loading = root.querySelector<HTMLElement>("[data-checkout-loading]")!;
  const unavailable = root.querySelector<HTMLElement>("[data-checkout-unavailable]")!;
  const contactStage = root.querySelector<HTMLElement>("[data-contact-stage]")!;
  const paymentStage = root.querySelector<HTMLElement>("[data-payment-stage]")!;
  const contactForm = root.querySelector<HTMLFormElement>("[data-contact-form]")!;
  const addressForm = root.querySelector<HTMLFormElement>("[data-address-form]")!;
  const live = root.querySelector<HTMLElement>("[data-checkout-live]")!;
  const payButton = root.querySelector<HTMLButtonElement>("[data-pay-button]")!;
  const checkStatus = root.querySelector<HTMLButtonElement>("[data-check-status]")!;
  const packageOptions = root.querySelector<HTMLElement>("[data-package-options]")!;
  const stripeShell = root.querySelector<HTMLElement>("[data-stripe-shell]")!;
  const orderSummary = root.querySelector<HTMLElement>("[data-order-summary]")!;
  let packages: PublicPackage[] = [];
  let selectedPackage: PackageCode = "digital";
  let resumeToken = readSession(RESUME_KEY);
  let currentTotals: Totals | null = null;
  let stripe: StripeClient | null = null;
  let elements: StripeElements | null = null;
  let paymentElement: StripeElement | null = null;
  let expressElement: StripeElement | null = null;
  let busy = false;
  let contactWasResumed = false;

  const announce = (message: string, kind: "info" | "error" = "info"): void => {
    live.textContent = message;
    live.dataset.kind = kind;
  };

  const showUnavailable = (message: string): void => {
    loading.hidden = true;
    contactStage.hidden = true;
    paymentStage.hidden = true;
    unavailable.hidden = false;
    setText(unavailable, "[data-unavailable-message]", message);
  };

  const setStage = (stage: "contact" | "payment"): void => {
    loading.hidden = true;
    unavailable.hidden = true;
    contactStage.hidden = stage !== "contact";
    paymentStage.hidden = stage !== "payment";
    const contactProgress = root.querySelector("[data-progress-contact]");
    const paymentProgress = root.querySelector("[data-progress-payment]");
    if (stage === "contact") {
      contactProgress?.setAttribute("aria-current", "step");
      paymentProgress?.removeAttribute("aria-current");
    } else {
      contactProgress?.removeAttribute("aria-current");
      paymentProgress?.setAttribute("aria-current", "step");
    }
    if (stage === "payment") renderPackages();
    requestAnimationFrame(() => {
      (stage === "contact"
        ? contactForm.querySelector<HTMLInputElement>("input")
        : addressForm.querySelector<HTMLInputElement>("input"))?.focus();
    });
  };

  const destroyPayment = (): void => {
    paymentElement?.destroy?.();
    expressElement?.destroy?.();
    paymentElement = null;
    expressElement = null;
    elements = null;
    stripe = null;
    currentTotals = null;
    stripeShell.hidden = true;
    orderSummary.hidden = true;
    payButton.disabled = true;
    checkStatus.hidden = true;
  };

  const saveContactForPackage = async (packageCode: PackageCode): Promise<string> => {
    const data = new FormData(contactForm);
    const firstName = String(data.get("firstName") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();
    const phone = String(data.get("phone") ?? "").trim();
    const smsMarketingConsent = data.get("smsMarketingConsent") === "on";
    const idempotencyStorageKey = `${IDEMPOTENCY_PREFIX}${packageCode}`;
    let idempotencyKey = readSession(idempotencyStorageKey);
    if (!idempotencyKey) {
      idempotencyKey = randomKey();
      writeSession(idempotencyStorageKey, idempotencyKey);
    }
    const { first: firstAttribution, latest: latestAttribution } = checkoutAttribution();
    const started = await api<{ resumeToken: string }>("/api/book/checkout/start", {
      packageCode,
      email,
      idempotencyKey,
      firstAttribution,
      latestAttribution,
      website: String(data.get("website") ?? ""),
    });
    if (!started.resumeToken) throw new ApiError(503, "Checkout could not be started.");
    await api("/api/book/checkout/contact", {
      resumeToken: started.resumeToken,
      firstName,
      email,
      ...(phone ? { phone } : {}),
      smsMarketingConsent,
    });
    return started.resumeToken;
  };

  const renderPackages = (): void => {
    packageOptions.replaceChildren();
    for (const pkg of packages) {
      const label = document.createElement("label");
      label.className = "bf-package-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "package";
      input.value = pkg.code;
      input.checked = pkg.code === selectedPackage;
      input.disabled = contactWasResumed && pkg.code !== selectedPackage;
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = pkg.name;
      const detail = document.createElement("small");
      detail.textContent =
        pkg.code === "digital"
          ? "PDF and EPUB · immediate secure access"
          : "Digital, audiobook, and printed edition";
      copy.append(title, detail);
      const price = document.createElement("b");
      price.textContent = formatUsd(pkg.amountCents + pkg.shippingCents);
      label.append(input, copy, price);
      packageOptions.append(label);

      input.addEventListener("change", () => {
        if (!input.checked) return;
        const previousPackage = selectedPackage;
        busy = true;
        packageOptions
          .querySelectorAll<HTMLInputElement>('input[type="radio"]')
          .forEach((radio) => { radio.disabled = true; });
        announce("Saving the new format to your secure checkout…");
        void saveContactForPackage(pkg.code)
          .then((nextToken) => {
            resumeToken = nextToken;
            selectedPackage = pkg.code;
            writeSession(RESUME_KEY, nextToken);
            writeSession(PACKAGE_KEY, selectedPackage);
            destroyPayment();
            updateAddressCopy();
            announce("Format changed. Recalculate the exact total before payment.");
          })
          .catch((error) => {
            selectedPackage = previousPackage;
            const previousInput = packageOptions
              .querySelector<HTMLInputElement>(`input[value="${previousPackage}"]`);
            if (previousInput) previousInput.checked = true;
            announce(
              statusMessage(error, "We couldn’t change the format. Your original checkout is unchanged."),
              "error",
            );
          })
          .finally(() => {
            busy = false;
            renderPackages();
          });
      });
    }
  };

  const updateAddressCopy = (): void => {
    const physical = selectedPackage === "complete";
    setText(root, "[data-address-title]", physical ? "Shipping address" : "Billing address");
    setText(
      root,
      "[data-address-note]",
      physical
        ? "Complete Collection currently ships only to supported U.S. addresses. Exact shipping and tax appear before payment."
        : "Used to calculate the exact tax before payment.",
    );
  };

  const renderTotals = (totals: Totals): void => {
    const pkg = packages.find((item) => item.code === selectedPackage);
    setText(orderSummary, "[data-total-subtotal]", formatUsd(totals.subtotalAmountCents));
    setText(orderSummary, "[data-total-discount]", `−${formatUsd(totals.discountAmountCents)}`);
    setText(
      orderSummary,
      "[data-total-shipping]",
      totals.shippingAmountCents === 0 ? "Included" : formatUsd(totals.shippingAmountCents),
    );
    setText(orderSummary, "[data-total-tax]", formatUsd(totals.taxAmountCents));
    setText(orderSummary, "[data-total-final]", formatUsd(totals.amountTotalCents));
    const discountRow = orderSummary.querySelector<HTMLElement>("[data-discount-row]");
    if (discountRow) discountRow.hidden = totals.discountAmountCents === 0;
    const lineItems = orderSummary.querySelector<HTMLElement>("[data-order-line-items]");
    if (lineItems) {
      lineItems.replaceChildren();
      const row = document.createElement("p");
      row.innerHTML = `<span></span><strong></strong>`;
      row.querySelector("span")!.textContent = pkg?.name ?? "Book edition";
      row.querySelector("strong")!.textContent = formatUsd(totals.subtotalAmountCents);
      lineItems.append(row);
    }
    const expiry = totals.quoteExpiresAt ? new Date(totals.quoteExpiresAt) : null;
    setText(
      orderSummary,
      "[data-quote-expiry]",
      expiry && !Number.isNaN(expiry.getTime())
        ? `Total held until ${expiry.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
        : "",
    );
    payButton.textContent = `Complete My Order — ${formatUsd(totals.amountTotalCents)}`;
    orderSummary.hidden = false;
  };

  const bonusBaseUrl = (): string => {
    const path = root.dataset.bonusUrl || "../bonus/";
    return new URL(path, location.href).toString();
  };

  const verifiedBonusUrl = (): string => {
    const url = new URL(bonusBaseUrl());
    url.hash = `checkout=${encodeURIComponent(resumeToken ?? "")}`;
    return url.toString();
  };

  const finishVerified = (): void => {
    location.assign(verifiedBonusUrl());
  };

  const pollForVerifiedPayment = async (): Promise<void> => {
    if (!resumeToken) return;
    checkStatus.hidden = true;
    for (let attempt = 0; attempt < 18; attempt++) {
      const state = await api<ResumeState>("/api/book/checkout/resume", {
        resumeToken,
      });
      if (state.status === "completed" && state.paymentState === "captured") {
        finishVerified();
        return;
      }
      if (state.paymentState === "failed" || state.paymentState === "canceled") {
        throw new ApiError(409, "Payment was not completed. Review your details and try again.");
      }
      announce("Payment is processing. We’re waiting for verified confirmation…");
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    announce(
      "Payment is still processing. Do not submit again. You can check status here, and your access email will arrive after confirmation.",
    );
    checkStatus.hidden = false;
  };

  const submitPayment = async (): Promise<void> => {
    if (busy || !stripe || !elements || !currentTotals) return;
    busy = true;
    payButton.disabled = true;
    setText(root, "[data-payment-error]", "");
    announce("Submitting secure payment…");
    try {
      const submitted = await elements.submit();
      if (submitted.error) throw new ApiError(400, submitted.error.message || "Review your payment details.");
      const address = parseAddress(addressForm);
      const contact = new FormData(contactForm);
      const result = await stripe.confirmPayment({
        elements,
        confirmParams: {
          // Stripe receives this value. Keep every checkout capability out of
          // it; same-tab redirect recovery reads sessionStorage on /book/bonus.
          return_url: bonusBaseUrl(),
          payment_method_data: {
            billing_details: {
              name: String(contact.get("firstName") ?? ""),
              email: String(contact.get("email") ?? ""),
              phone: String(contact.get("phone") ?? "") || undefined,
              address: {
                line1: address.line1,
                line2: address.line2,
                city: address.city,
                state: address.state,
                postal_code: address.postalCode,
                country: address.country,
              },
            },
          },
        },
        redirect: "if_required",
      });
      if (result.error) {
        throw new ApiError(402, result.error.message || "Payment was declined. Try another payment method.");
      }
      await pollForVerifiedPayment();
    } catch (error) {
      const message = statusMessage(error, "Payment could not be completed. Please try again.");
      setText(root, "[data-payment-error]", message);
      announce(message, "error");
      payButton.disabled = false;
    } finally {
      busy = false;
    }
  };

  const mountStripe = (
    publishableKey: string,
    clientSecret: string,
    totals: Totals,
  ): void => {
    if (!window.Stripe) {
      throw new ApiError(503, "Secure payment could not load. Check your connection and try again.");
    }
    stripe = window.Stripe(publishableKey);
    elements = stripe.elements({
      clientSecret,
      appearance: {
        theme: "stripe",
        variables: {
          colorPrimary: "#8A292F",
          colorText: "#524B3A",
          colorBackground: "#FAF8F4",
          borderRadius: "2px",
          fontFamily: "Arial, sans-serif",
        },
      },
    });
    paymentElement = elements.create("payment", {
      layout: "tabs",
      fields: { billingDetails: { address: "never" } },
    });
    paymentElement.mount(root.querySelector<HTMLElement>("[data-payment-element]")!);
    expressElement = elements.create("expressCheckout", {
      buttonType: { applePay: "buy", googlePay: "buy" },
    });
    expressElement.on?.("ready", (event) => {
      const methods = event?.availablePaymentMethods;
      root.querySelector<HTMLElement>("[data-express-wrap]")!.hidden = !methods;
    });
    expressElement.on?.("confirm", () => {
      void submitPayment();
    });
    expressElement.mount(root.querySelector<HTMLElement>("[data-express-element]")!);
    currentTotals = totals;
    renderTotals(totals);
    stripeShell.hidden = false;
    payButton.disabled = false;
    announce("Exact total ready. Complete payment when you’re ready.");
  };

  contactForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !contactForm.reportValidity()) return;
    const data = new FormData(contactForm);
    const firstName = String(data.get("firstName") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();
    const phone = String(data.get("phone") ?? "").trim();
    const smsMarketingConsent = data.get("smsMarketingConsent") === "on";
    if (!firstName) {
      setText(root, '[data-error-for="firstName"]', "Enter your first name.");
      root.querySelector<HTMLInputElement>("#book-first-name")?.focus();
      return;
    }
    setText(root, '[data-error-for="firstName"]', "");
    if (smsMarketingConsent && !phone) {
      setText(root, '[data-error-for="phone"]', "Enter a mobile number or leave text updates unchecked.");
      root.querySelector<HTMLInputElement>("#book-phone")?.focus();
      return;
    }
    setText(root, '[data-error-for="phone"]', "");
    busy = true;
    const button = root.querySelector<HTMLButtonElement>("[data-contact-submit]");
    if (button) button.disabled = true;
    announce("Saving your progress securely…");
    try {
      resumeToken = await saveContactForPackage(selectedPackage);
      writeSession(RESUME_KEY, resumeToken);
      writeSession(PACKAGE_KEY, selectedPackage);
      contactWasResumed = false;
      setStage("payment");
      updateAddressCopy();
      announce("Progress saved. Enter your address to calculate the exact total.");
    } catch (error) {
      const message = statusMessage(error, "We couldn’t save your contact information. Please try again.");
      announce(message, "error");
      if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
        removeSession(RESUME_KEY);
        resumeToken = null;
      }
    } finally {
      busy = false;
      if (button) button.disabled = false;
    }
  });

  contactForm.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.name === "firstName" && input.value.trim()) {
      setText(root, '[data-error-for="firstName"]', "");
    }
    if (input.name === "phone") {
      setText(root, '[data-error-for="phone"]', "");
    }
  });

  addressForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !resumeToken || !addressForm.reportValidity()) return;
    busy = true;
    const button = root.querySelector<HTMLButtonElement>("[data-quote-submit]");
    if (button) button.disabled = true;
    destroyPayment();
    announce("Calculating authoritative shipping and tax…");
    try {
      const quote = await api<Totals>("/api/book/checkout/totals", {
        resumeToken,
        address: parseAddress(addressForm),
      });
      const intent = await api<
        Totals & { clientSecret: string; publishableKey: string }
      >("/api/book/checkout/payment-intent", { resumeToken });
      mountStripe(intent.publishableKey, intent.clientSecret, {
        ...intent,
        quoteExpiresAt: quote.quoteExpiresAt,
      });
    } catch (error) {
      const message = statusMessage(error, "We couldn’t prepare payment. Please try again.");
      announce(message, "error");
      if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
        showUnavailable(message);
      }
    } finally {
      busy = false;
      if (button) button.disabled = false;
    }
  });

  addressForm.addEventListener("input", () => {
    if (!currentTotals) return;
    destroyPayment();
    announce("Address changed. Recalculate the exact total before payment.");
  });
  payButton.addEventListener("click", () => void submitPayment());
  checkStatus.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    void pollForVerifiedPayment()
      .catch((error) => announce(statusMessage(error, "Status is temporarily unavailable."), "error"))
      .finally(() => {
        busy = false;
      });
  });
  root.querySelector("[data-back-contact]")?.addEventListener("click", () => {
    destroyPayment();
    setStage("contact");
    announce("Your secure checkout is saved. Update contact details or continue again.");
  });
  root.querySelector("[data-checkout-retry]")?.addEventListener("click", () => location.reload());

  const boot = async (): Promise<void> => {
    try {
      const catalog = await api<{ packages?: unknown }>("/api/book/checkout/catalog");
      packages = Array.isArray(catalog.packages) ? catalog.packages.filter(isPackage) : [];
      if (packages.length === 0) {
        showUnavailable("No direct book package is currently available. Please check back soon.");
        return;
      }
      const requested = new URLSearchParams(location.search).get("package");
      const storedPackage = readSession(PACKAGE_KEY);
      const availableRequested = packages.find((pkg) => pkg.code === requested);
      const availableStored = packages.find((pkg) => pkg.code === storedPackage);
      selectedPackage =
        availableRequested?.code ??
        availableStored?.code ??
        packages.find((pkg) => pkg.code === "digital")?.code ??
        packages[0].code;
      if (requested && !availableRequested) {
        announce("That format is not available. We selected the available Digital Edition instead.");
      }
      updateAddressCopy();
      if (!resumeToken) {
        setStage("contact");
        return;
      }
      try {
        const state = await api<ResumeState>("/api/book/checkout/resume", { resumeToken });
        if (state.status === "completed") {
          finishVerified();
          return;
        }
        selectedPackage = packages.some((pkg) => pkg.code === state.packageCode)
          ? state.packageCode
          : selectedPackage;
        if (state.contactComplete) {
          contactWasResumed = true;
          setStage("payment");
          announce("Your saved checkout is ready. Recalculate the exact total to continue.");
        } else {
          setStage("contact");
        }
      } catch (error) {
        removeSession(RESUME_KEY);
        resumeToken = null;
        setStage("contact");
        announce(statusMessage(error, "Start a new secure checkout to continue."), "error");
      }
    } catch (error) {
      showUnavailable(statusMessage(error, "Checkout is temporarily unavailable. Please try again."));
    }
  };

  void boot();
}

function initBonus(root: HTMLElement): void {
  const hash = clearFragment();
  const token = hash.get("checkout") || readSession(RESUME_KEY);
  const status = root.querySelector<HTMLElement>("[data-bonus-status]")!;
  const links = [
    ...root.querySelectorAll<HTMLAnchorElement>("[data-access-book],[data-access-book-alt]"),
  ];
  const applyLink = root.querySelector<HTMLAnchorElement>("[data-apply-book-bonus]");
  setupResendForm(root);

  if (!token) {
    status.textContent =
      "Your secure checkout reference is no longer in this browser. Use the access email sent after purchase, or request a fresh one below.";
    return;
  }
  writeSession(RESUME_KEY, token);

  const verify = async (): Promise<void> => {
    for (let attempt = 0; attempt < 18; attempt++) {
      const state = await api<ResumeState>("/api/book/checkout/resume", {
        resumeToken: token,
      });
      if (state.status === "completed" && state.accessToken) {
        const accessUrl = new URL("../access/", location.href);
        accessUrl.hash = `access=${encodeURIComponent(state.accessToken)}`;
        for (const link of links) {
          link.href = accessUrl.toString();
          link.hidden = false;
        }
        status.textContent = "Payment verified. Your secure digital edition is available now.";
        if (applyLink) {
          const applyUrl = new URL(applyLink.href, location.href);
          applyUrl.hash = `checkout=${encodeURIComponent(token)}`;
          applyLink.href = applyUrl.toString();
          applyLink.hidden = false;
        }
        return;
      }
      status.textContent =
        "Payment is still processing. Keep this page open while we wait for verified confirmation…";
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    status.textContent =
      "Your payment is still being verified. Do not pay again. We’ll email secure access as soon as confirmation arrives.";
  };

  void verify().catch((error) => {
    status.textContent = statusMessage(
      error,
      "We couldn’t verify this browser session. Use your purchase email to request a fresh access link.",
    );
  });
}

function showJourneyOutcome(root: HTMLElement, state: JourneyState): void {
  const form = root.querySelector<HTMLElement>("[data-application-form]");
  const manual = root.querySelector<HTMLElement>("[data-outcome-manual]");
  const processing = root.querySelector<HTMLElement>("[data-outcome-processing]");
  const alternate = root.querySelector<HTMLElement>("[data-outcome-alternate]");
  const qualified = root.querySelector<HTMLElement>("[data-outcome-qualified]");
  if (form) form.hidden = state.outcome !== "in_progress";
  if (manual) manual.hidden = state.outcome !== "manual_review";
  if (processing) processing.hidden = state.outcome !== "processing";
  if (alternate) alternate.hidden = state.outcome !== "alternate_next_step";
  if (qualified) qualified.hidden = state.outcome !== "qualified";
}

function initApply(root: HTMLElement): void {
  const hash = clearFragment();
  const resumeToken = hash.get("checkout") || readSession(RESUME_KEY);
  const status = root.querySelector<HTMLElement>("[data-journey-status]")!;
  const recovery = root.querySelector<HTMLElement>("[data-apply-recovery]")!;
  const form = root.querySelector<HTMLFormElement>("[data-application-form]")!;
  const submit = root.querySelector<HTMLButtonElement>("[data-application-submit]")!;
  const error = root.querySelector<HTMLElement>("[data-application-error]")!;
  const loadCalendar = root.querySelector<HTMLButtonElement>("[data-load-calendar]")!;
  const calendarShell = root.querySelector<HTMLElement>("[data-calendar-shell]")!;
  const fallback = root.querySelector<HTMLElement>("[data-calendar-fallback]")!;
  const calendarOpen = root.querySelector<HTMLAnchorElement>("[data-calendar-open]")!;
  const bookingStatus = root.querySelector<HTMLAnchorElement>("[data-booking-status]")!;
  const resumeApplicationKey = resumeToken
    ? `${APPLICATION_TOKEN_KEY}:${resumeToken.slice(0, 16)}`
    : null;
  const explicitApplicationToken = hash.get("application");
  const canPersistCheckoutScopedApplication = !explicitApplicationToken;
  let applicationToken =
    explicitApplicationToken ||
    (resumeApplicationKey ? readSession(resumeApplicationKey) : null) ||
    (!resumeToken ? readSession(APPLICATION_TOKEN_KEY) : null);
  let calendarUrl: string | null = null;

  void refreshAccessUrl(root, resumeToken);

  const render = (state: JourneyState): void => {
    applicationToken = state.applicationToken;
    writeSession(APPLICATION_TOKEN_KEY, applicationToken);
    if (resumeApplicationKey && canPersistCheckoutScopedApplication) {
      writeSession(resumeApplicationKey, applicationToken);
    }
    showJourneyOutcome(root, state);
    error.textContent = "";
    if (state.outcome === "in_progress") {
      status.textContent = "Purchase confirmed. Complete the five questions below.";
      return;
    }
    if (state.outcome === "manual_review") {
      status.textContent = "Application received for personal review.";
      return;
    }
    if (state.outcome === "processing") {
      status.textContent =
        "Application saved. We’re safely finalizing the approved routing step.";
      return;
    }
    if (state.outcome === "alternate_next_step") {
      status.textContent = "Application received. Your best next step is available below.";
      return;
    }
    status.textContent = state.calendar.available
      ? "Application approved. Your GHL calendar is ready when you are."
      : "Application approved. Calendar availability is temporarily unavailable.";
    calendarUrl =
      state.calendar.available && typeof state.calendar.url === "string"
        ? state.calendar.url
        : null;
    loadCalendar.hidden = !calendarUrl;
    if (!calendarUrl) {
      fallback.hidden = false;
      fallback.querySelector("p")!.textContent =
        "Your qualification is saved, but an approved calendar is not available right now. Your book access is unaffected.";
      calendarOpen.hidden = true;
    }
    const thanksUrl = new URL(root.dataset.thanksUrl || "../thanks/", location.href);
    thanksUrl.hash = `application=${encodeURIComponent(applicationToken)}`;
    bookingStatus.href = thanksUrl.toString();
    bookingStatus.hidden = false;
  };

  const resumeProcessing = async (): Promise<void> => {
    if (!applicationToken) return;
    const state = await api<JourneyState>("/api/book/journey/submit", {
      applicationToken,
    });
    render(state);
  };

  const boot = async (): Promise<void> => {
    if (applicationToken) {
      try {
        const recovered = await api<JourneyState>("/api/book/journey/status", {
          applicationToken,
        });
        render(recovered);
        if (recovered.outcome === "processing") await resumeProcessing();
        return;
      } catch (error) {
        if (explicitApplicationToken || !resumeToken) throw error;
        if (resumeApplicationKey) removeSession(resumeApplicationKey);
        if (readSession(APPLICATION_TOKEN_KEY) === applicationToken) {
          removeSession(APPLICATION_TOKEN_KEY);
        }
        applicationToken = null;
      }
    }
    if (!resumeToken) {
      status.textContent =
        "We can’t confirm this browser session. Your book access is still available.";
      recovery.hidden = false;
      form.hidden = true;
      return;
    }
    const state = await api<JourneyState>("/api/book/journey/start", {
      resumeToken,
    });
    render(state);
    if (state.outcome === "processing") await resumeProcessing();
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!applicationToken || !form.reportValidity()) return;
    submit.disabled = true;
    error.textContent = "";
    const data = new FormData(form);
    try {
      const state = await api<JourneyState>("/api/book/journey/submit", {
        applicationToken,
        answers: {
          role: String(data.get("role") ?? ""),
          practiceArea: String(data.get("practiceArea") ?? "").trim(),
          monthlyQualifiedInquiries: String(data.get("monthlyQualifiedInquiries") ?? ""),
          annualFirmRevenue: String(data.get("annualFirmRevenue") ?? ""),
          improvementTiming: String(data.get("improvementTiming") ?? ""),
        },
      });
      render(state);
      root.querySelector<HTMLElement>("[data-outcome-manual]:not([hidden]),[data-outcome-alternate]:not([hidden]),[data-outcome-qualified]:not([hidden])")?.focus();
    } catch (requestError) {
      error.textContent = statusMessage(
        requestError,
        "We couldn’t save the application. Your answers remain here; please try again.",
      );
    } finally {
      submit.disabled = false;
    }
  });

  root
    .querySelector<HTMLButtonElement>("[data-resume-application]")
    ?.addEventListener("click", () => {
      void resumeProcessing().catch((requestError) => {
        status.textContent = statusMessage(
          requestError,
          "The final routing step is still pending. Your application is saved; please try again.",
        );
      });
    });

  loadCalendar.addEventListener("click", () => {
    if (!calendarUrl || calendarShell.querySelector("iframe")) return;
    loadCalendar.disabled = true;
    calendarShell.hidden = false;
    fallback.hidden = true;
    const iframe = document.createElement("iframe");
    iframe.title = "Schedule your High-Impact Revenue Session";
    iframe.src = calendarUrl;
    iframe.loading = "lazy";
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.setAttribute("allow", "payment");
    let loaded = false;
    iframe.addEventListener("load", () => {
      loaded = true;
      loadCalendar.hidden = true;
    });
    calendarShell.append(iframe);
    calendarOpen.href = calendarUrl;
    window.setTimeout(() => {
      if (!loaded) fallback.hidden = false;
    }, 8_000);
  });

  void boot().catch((bootError) => {
    status.textContent = statusMessage(
      bootError,
      "We couldn’t prepare the application. Your book access is unaffected.",
    );
    recovery.hidden = false;
    form.hidden = true;
  });
}

function icsDate(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function downloadAppointmentCalendar(appointment: JourneyState["appointment"]): void {
  if (!appointment.scheduledAt || !appointment.endAt) return;
  const title = appointment.meetingTypeName || "High-Impact Revenue Session";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NoBull Marketing//Buyer Session//EN",
    "BEGIN:VEVENT",
    `DTSTART:${icsDate(new Date(appointment.scheduledAt))}`,
    `DTEND:${icsDate(new Date(appointment.endAt))}`,
    `SUMMARY:${title.replace(/[\\,;]/g, "\\$&")}`,
    ...(appointment.meetingLink
      ? [`URL:${appointment.meetingLink}`, `LOCATION:${appointment.meetingLink}`]
      : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const url = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/calendar" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "nobull-revenue-session.ics";
  link.click();
  URL.revokeObjectURL(url);
}

function initThanks(root: HTMLElement): void {
  const hash = clearFragment();
  const fromHash = hash.get("application");
  if (fromHash) writeSession(APPLICATION_TOKEN_KEY, fromHash);
  const applicationToken = fromHash || readSession(APPLICATION_TOKEN_KEY);
  const status = root.querySelector<HTMLElement>("[data-thanks-status]")!;
  const heading = root.querySelector<HTMLElement>("[data-thanks-heading]")!;
  const details = root.querySelector<HTMLElement>("[data-appointment-details]")!;
  const pending = root.querySelector<HTMLElement>("[data-appointment-pending]")!;
  const refresh = root.querySelector<HTMLButtonElement>("[data-refresh-appointment]")!;
  const addCalendar = root.querySelector<HTMLButtonElement>("[data-add-calendar]")!;
  const meetingLink = root.querySelector<HTMLAnchorElement>("[data-meeting-link]")!;
  let currentAppointment: JourneyState["appointment"] | null = null;

  void refreshAccessUrl(root, readSession(RESUME_KEY));

  const load = async (): Promise<void> => {
    if (!applicationToken) {
      heading.textContent = "We can’t verify an appointment in this browser.";
      status.textContent =
        "Use the confirmation link from your application or booking email. Your book access is still available.";
      pending.hidden = false;
      refresh.hidden = true;
      return;
    }
    refresh.disabled = true;
    try {
      const state = await api<JourneyState>("/api/book/journey/status", {
        applicationToken,
      });
      currentAppointment = state.appointment;
      const appointment = state.appointment;
      if (appointment.status !== "scheduled" || !appointment.scheduledAt) {
        heading.textContent = "Your application is safe.";
        status.textContent =
          "We have not received verified appointment details from the trusted mirror yet.";
        details.hidden = true;
        pending.hidden = false;
        return;
      }
      heading.textContent = "You’re booked. Let’s make the session useful.";
      status.textContent = "Your verified appointment details are below.";
      pending.hidden = true;
      details.hidden = false;
      const timezone = appointment.timezone || "UTC";
      const start = new Date(appointment.scheduledAt);
      setText(
        details,
        "[data-appointment-time]",
        new Intl.DateTimeFormat(undefined, {
          dateStyle: "full",
          timeStyle: "short",
          timeZone: timezone,
        }).format(start),
      );
      setText(details, "[data-appointment-timezone]", timezone);
      if (appointment.meetingTypeName) {
        setText(details, "[data-appointment-type]", appointment.meetingTypeName);
        details.querySelector<HTMLElement>("[data-appointment-type-row]")!.hidden = false;
      }
      if (appointment.hostName) {
        setText(details, "[data-appointment-host]", appointment.hostName);
        details.querySelector<HTMLElement>("[data-appointment-host-row]")!.hidden = false;
      }
      if (appointment.meetingLink) {
        meetingLink.href = appointment.meetingLink;
        meetingLink.hidden = false;
      }
      addCalendar.hidden = !appointment.endAt;
    } catch (requestError) {
      status.textContent = statusMessage(
        requestError,
        "We couldn’t refresh the appointment. Your application and book access are safe.",
      );
      pending.hidden = false;
    } finally {
      refresh.disabled = false;
    }
  };

  refresh.addEventListener("click", () => void load());
  addCalendar.addEventListener("click", () => {
    if (currentAppointment) downloadAppointmentCalendar(currentAppointment);
  });
  void load();
}

function initAccess(root: HTMLElement): void {
  const hash = clearFragment();
  const token = hash.get("access");
  const status = root.querySelector<HTMLElement>("[data-access-status]")!;
  const assetsRoot = root.querySelector<HTMLElement>("[data-access-assets]")!;
  const recovery = root.querySelector<HTMLElement>("[data-delivery-resend-form]")!;
  const orderStatusLink = root.querySelector<HTMLElement>("[data-order-status-link]");
  setupResendForm(root);

  const load = async (): Promise<void> => {
    if (token) {
      await api<void>("/api/book/delivery/exchange", { token });
    }
    const result = await api<{ assets?: unknown }>("/api/book/delivery/assets");
    const assets = Array.isArray(result.assets)
      ? result.assets.filter(
          (asset): asset is {
            id: string;
            filename: string;
            contentType: string;
            entitlementCode: "digital_book" | "audiobook";
          } =>
            !!asset &&
            typeof asset === "object" &&
            typeof (asset as Record<string, unknown>).id === "string" &&
            typeof (asset as Record<string, unknown>).filename === "string" &&
            typeof (asset as Record<string, unknown>).contentType === "string" &&
            ((asset as Record<string, unknown>).entitlementCode === "digital_book" ||
              (asset as Record<string, unknown>).entitlementCode === "audiobook"),
        )
      : [];
    assetsRoot.replaceChildren();
    if (orderStatusLink) orderStatusLink.hidden = false;
    if (assets.length === 0) {
      status.textContent =
        "Your purchase is verified, but no approved download is available right now. We’ll email you when your entitled file is ready.";
      return;
    }
    status.textContent =
      assets.length === 1
        ? "Secure access verified. Your entitled file is ready."
        : "Secure access verified. Your currently entitled files are ready.";
    for (const asset of assets) {
      const link = document.createElement("a");
      link.className = "bf-download";
      link.href = `/api/book/delivery/download/${encodeURIComponent(asset.id)}`;
      const copy = document.createElement("span");
      copy.className = "bf-download-copy";
      const title = document.createElement("strong");
      title.textContent =
        asset.entitlementCode === "audiobook" ? "Download audiobook" : "Download digital book";
      const detail = document.createElement("span");
      detail.textContent = asset.filename;
      copy.append(title, detail);
      link.append(copy);
      assetsRoot.append(link);
    }
  };

  void load().catch(() => {
    status.textContent =
      "This access link is unavailable or has expired. Request a fresh secure link below.";
    recovery.hidden = false;
  });
}

type BuyerOrderStatus = {
  orderNumber: string;
  placedAt: string;
  packageCode: "digital" | "complete";
  packageLabel: string;
  orderState: "confirmed" | "partially_refunded" | "refunded" | "cancelled" | "under_review";
  currency: "USD";
  totalAmountCents: number;
  refundedAmountCents: number;
  digitalDelivery: "available" | "preparing" | "unavailable";
  audioDelivery: "available" | "preparing" | "not_included";
  physicalFulfillment: "not_active" | "not_included";
};

function isBuyerOrderStatus(value: unknown): value is BuyerOrderStatus {
  if (!value || typeof value !== "object") return false;
  const order = value as Record<string, unknown>;
  return (
    typeof order.orderNumber === "string" &&
    typeof order.placedAt === "string" &&
    (order.packageCode === "digital" || order.packageCode === "complete") &&
    typeof order.packageLabel === "string" &&
    ["confirmed", "partially_refunded", "refunded", "cancelled", "under_review"].includes(
      String(order.orderState),
    ) &&
    order.currency === "USD" &&
    Number.isInteger(order.totalAmountCents) &&
    Number.isInteger(order.refundedAmountCents) &&
    ["available", "preparing", "unavailable"].includes(String(order.digitalDelivery)) &&
    ["available", "preparing", "not_included"].includes(String(order.audioDelivery)) &&
    ["not_active", "not_included"].includes(String(order.physicalFulfillment))
  );
}

function initOrderStatus(root: HTMLElement): void {
  clearFragment();
  setupResendForm(root);
  const message = root.querySelector<HTMLElement>("[data-order-status-message]")!;
  const panel = root.querySelector<HTMLElement>("[data-order-summary-panel]")!;
  const recovery = root.querySelector<HTMLElement>("[data-delivery-resend-form]")!;
  const set = (selector: string, value: string): void => {
    const target = root.querySelector<HTMLElement>(selector);
    if (target) target.textContent = value;
  };
  const deliveryLabel = (value: BuyerOrderStatus["digitalDelivery"]): string => {
    if (value === "available") return "Ready in your secure access center";
    if (value === "preparing") return "Entitled — approved file is being prepared";
    return "Unavailable — contact support if this seems incorrect";
  };

  void api<{ order?: unknown }>("/api/book/delivery/order-status")
    .then(({ order }) => {
      if (!isBuyerOrderStatus(order)) throw new Error("Invalid order-status response");
      const placedAt = new Date(order.placedAt);
      if (!Number.isFinite(placedAt.getTime())) throw new Error("Invalid order date");
      set("[data-order-number]", order.orderNumber);
      set("[data-order-package]", order.packageLabel);
      set(
        "[data-order-date]",
        new Intl.DateTimeFormat("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        }).format(placedAt),
      );
      set("[data-order-total]", formatUsd(order.totalAmountCents));
      const orderStateLabel: Record<BuyerOrderStatus["orderState"], string> = {
        confirmed: "Payment confirmed",
        partially_refunded: `Partially refunded (${formatUsd(order.refundedAmountCents)})`,
        refunded: "Refunded",
        cancelled: "Cancelled",
        under_review: "Payment under review",
      };
      set("[data-order-state]", orderStateLabel[order.orderState]);
      set("[data-order-digital]", deliveryLabel(order.digitalDelivery));
      const audioRow = root.querySelector<HTMLElement>("[data-order-audio-row]");
      if (order.audioDelivery !== "not_included" && audioRow) {
        audioRow.hidden = false;
        set("[data-order-audio]", deliveryLabel(order.audioDelivery));
      }
      const physicalRow = root.querySelector<HTMLElement>("[data-order-physical-row]");
      if (order.physicalFulfillment === "not_active" && physicalRow) {
        physicalRow.hidden = false;
        set(
          "[data-order-physical]",
          "Not active — no shipment, carrier, or tracking details are available",
        );
      }
      message.textContent = "Secure order access verified.";
      panel.hidden = false;
    })
    .catch(() => {
      message.textContent =
        "Order access is unavailable or has expired. Open a fresh secure link to continue.";
      recovery.hidden = false;
    });
}

const checkout = document.querySelector<HTMLElement>("[data-book-checkout]");
const bonus = document.querySelector<HTMLElement>("[data-book-bonus]");
const access = document.querySelector<HTMLElement>("[data-book-access]");
const orderStatus = document.querySelector<HTMLElement>("[data-book-order-status]");
const apply = document.querySelector<HTMLElement>("[data-book-apply]");
const thanks = document.querySelector<HTMLElement>("[data-book-thanks]");
if (checkout) initCheckout(checkout);
if (bonus) initBonus(bonus);
if (access) initAccess(access);
if (orderStatus) initOrderStatus(orderStatus);
if (apply) initApply(apply);
if (thanks) initThanks(thanks);