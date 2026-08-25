// Shared inquiry-form wiring for the marketing site — the ONE source of the
// /api/website/inquiry submit behavior, compiled into BOTH client bundles
// (assets/js/home.js via website/src/home-client/main.ts and assets/js/site.js
// via website/src/site-client/main.ts). PR5 replaced the two previously
// diverging implementations (a typed single-form handler in home-client and a
// hand-authored multi-form handler in the old public/assets/js/site.js) with
// this module and ONE data-attribute contract:
//
//   <form data-nb-inquiry="contact|unsubscribe"   ← attribute value = kind
//         data-success="…">                       ← optional success copy
//     …the subset of named fields this form renders
//        (fullName / email / phone / message)…
//     <input type="text" name="website">          ← honeypot, humans leave it
//     <el data-nb-form-msg>                       ← status line
//   </form>
//
// The status element is stamped in BOTH styling languages the two page
// classes use: data-kind="ok|err" (home.css attribute selectors) and .ok/.err
// classes (site.css keeps .form-msg display:none until a class lands, so
// subpages deliberately show nothing while a request is in flight — their
// feedback is the swapped button label).
//
// The behavior is the superset of the two prior handlers:
//   - client-side required-field validation before POSTing, scoped to the
//     canonical fields PRESENT in the form (previously homepage-only; the
//     email-only unsubscribe form validates just its email);
//   - kind read from the attribute value, per-form data-success copy, and
//     server-provided error messages rendered verbatim (previously
//     subpage-only; the route writes visitor-facing validation and
//     rate-limit copy);
//   - submit button disabled + label swapped to "Sending…" in flight, with
//     the original markup restored afterwards (the homepage button contains
//     an arrow <span>, so innerHTML — not textContent — is what's restored).

// Absolute path on purpose: the API lives on the same origin on both the
// marketing domain and the OS preview host, but the page itself may be
// served under a /website-preview/ prefix where a relative URL would break.
const INQUIRY_ENDPOINT = "/api/website/inquiry";
const RECAPTCHA_CONFIG_ENDPOINT = "/api/website/inquiry/config";
const RECAPTCHA_SCRIPT_URL =
  "https://www.google.com/recaptcha/api.js?render=explicit";

// Task #4337 — submissions attach the visitor's stored first-touch
// attribution (write-once localStorage record captured at page init by
// captureFirstTouchAttribution in the bundle entrypoints).
import { getStoredAttribution } from "./attribution";

// Canonical field names → the wording used in the validation message, in
// sentence order ("Please fill in your name, email, phone, and message.").
const FIELDS: ReadonlyArray<readonly [name: string, label: string]> = [
  ["fullName", "name"],
  ["email", "email"],
  ["phone", "phone"],
  ["message", "message"],
];

const DEFAULT_SUCCESS =
  "Thanks — your message is on its way. We’ll get back to you shortly.";
const RECAPTCHA_MISSING =
  "Please complete the security check and try again.";
const RECAPTCHA_UNAVAILABLE =
  "Security verification is unavailable right now. Please refresh the page and try again, or book a session instead.";
const RECAPTCHA_LOADING =
  "Security verification is still loading. Please wait a moment and try again.";
const RECAPTCHA_EXPIRED =
  "Security verification expired. Please complete the check again.";

interface RecaptchaApi {
  ready(callback: () => void): void;
  render(
    element: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): number;
  reset(widgetId: number): void;
}

declare global {
  interface Window {
    grecaptcha?: RecaptchaApi;
  }
}

let recaptchaConfigPromise: Promise<string> | null = null;
let recaptchaScriptPromise: Promise<RecaptchaApi> | null = null;

function waitForRecaptchaReady(recaptcha: RecaptchaApi): Promise<RecaptchaApi> {
  return new Promise((resolve, reject) => {
    try {
      recaptcha.ready(() => resolve(recaptcha));
    } catch (error) {
      reject(error);
    }
  });
}

function loadRecaptchaSiteKey(): Promise<string> {
  if (!recaptchaConfigPromise) {
    recaptchaConfigPromise = fetch(RECAPTCHA_CONFIG_ENDPOINT, {
      headers: { Accept: "application/json" },
    }).then(async (response) => {
      if (!response.ok) throw new Error("reCAPTCHA configuration unavailable");
      const body = (await response.json()) as { recaptchaSiteKey?: unknown };
      const siteKey =
        typeof body.recaptchaSiteKey === "string"
          ? body.recaptchaSiteKey.trim()
          : "";
      if (!siteKey || siteKey.length > 500) {
        throw new Error("reCAPTCHA site key unavailable");
      }
      return siteKey;
    });
  }
  return recaptchaConfigPromise;
}

function loadRecaptchaScript(): Promise<RecaptchaApi> {
  if (window.grecaptcha) return waitForRecaptchaReady(window.grecaptcha);
  if (!recaptchaScriptPromise) {
    recaptchaScriptPromise = new Promise<RecaptchaApi>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        `script[src="${RECAPTCHA_SCRIPT_URL}"]`,
      );
      const script = existing ?? document.createElement("script");
      const onLoad = (): void => {
        if (window.grecaptcha) {
          void waitForRecaptchaReady(window.grecaptcha).then(resolve, reject);
        }
        else reject(new Error("reCAPTCHA script loaded without an API"));
      };
      const onError = (): void =>
        reject(new Error("reCAPTCHA script failed to load"));
      script.addEventListener("load", onLoad, { once: true });
      script.addEventListener("error", onError, { once: true });
      if (!existing) {
        script.src = RECAPTCHA_SCRIPT_URL;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
    });
  }
  return recaptchaScriptPromise;
}

/** "name" | "name and email" | "name, email, and phone" */
function humanList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Non-2xx response; carries the server's visitor-facing message when the
    JSON body had one (those render verbatim — the route writes its
    validation/rate-limit copy for humans). */
class InquiryRequestError extends Error {
  readonly serverMessage: string | null;

  constructor(serverMessage: string | undefined, status: number) {
    super(serverMessage || `Request failed (${status})`);
    this.serverMessage = serverMessage || null;
  }
}

function wireForm(form: HTMLFormElement): void {
  // The attribute VALUE is the inquiry kind ("contact", "unsubscribe"),
  // posted as-is. No fallback: a template that forgets the value fails the
  // server's kind enum loudly instead of silently mislabeling leads.
  const kind = form.getAttribute("data-nb-inquiry") ?? "";
  const msg = form.querySelector<HTMLElement>("[data-nb-form-msg]");
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  const recaptchaHost = form.querySelector<HTMLElement>("[data-nb-captcha]");
  let recaptchaToken = "";
  let recaptchaWidgetId: number | null = null;
  let recaptchaState:
    | "loading"
    | "ready"
    | "expired"
    | "unavailable" = "loading";

  const setMsg = (text: string, state: "" | "ok" | "err"): void => {
    if (!msg) return;
    msg.textContent = text;
    msg.dataset.kind = state;
    msg.classList.toggle("ok", state === "ok");
    msg.classList.toggle("err", state === "err");
  };

  const resetRecaptcha = (): void => {
    recaptchaToken = "";
    if (recaptchaWidgetId !== null && window.grecaptcha) {
      window.grecaptcha.reset(recaptchaWidgetId);
    }
  };

  if (kind === "contact") {
    if (!recaptchaHost) {
      recaptchaState = "unavailable";
      setMsg(RECAPTCHA_UNAVAILABLE, "err");
    } else {
      setMsg("Loading security verification…", "");
      void loadRecaptchaSiteKey()
        .then(async (siteKey) => {
          const recaptcha = await loadRecaptchaScript();
          recaptchaWidgetId = recaptcha.render(recaptchaHost, {
            sitekey: siteKey,
            callback: (token) => {
              recaptchaToken = token;
              recaptchaState = "ready";
              setMsg("", "");
            },
            "expired-callback": () => {
              recaptchaToken = "";
              recaptchaState = "expired";
              setMsg(RECAPTCHA_EXPIRED, "err");
            },
            "error-callback": () => {
              recaptchaToken = "";
              recaptchaState = "unavailable";
              setMsg(RECAPTCHA_UNAVAILABLE, "err");
            },
          });
          recaptchaHost.dataset.nbCaptchaReady = "true";
          recaptchaState = "ready";
          setMsg("", "");
        })
        .catch(() => {
          recaptchaState = "unavailable";
          recaptchaHost.dataset.nbCaptchaReady = "false";
          setMsg(RECAPTCHA_UNAVAILABLE, "err");
        });
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const data = new FormData(form);

    const payload: Record<string, string> = {
      kind,
      page: window.location.pathname,
      // Honeypot — visually hidden; humans leave it empty. Sent untrimmed:
      // the server treats ANY content as a bot trip.
      website: String(data.get("website") ?? ""),
    };

    // Task #4337 — first-touch attribution (utm_* / external referrer).
    // Absent fields simply aren't sent; the endpoint treats them as optional.
    for (const [key, value] of Object.entries(getStoredAttribution())) {
      if (value) payload[key] = value;
    }

    // Required-field validation scoped to the canonical fields this form
    // actually renders (contact forms carry all four, unsubscribe only
    // email). The server stays authoritative — this only saves a round trip.
    const missing: string[] = [];
    for (const [name, label] of FIELDS) {
      if (!form.elements.namedItem(name)) continue; // not on this form
      const value = String(data.get(name) ?? "").trim();
      payload[name] = value;
      if (!value) missing.push(label);
    }
    if (missing.length > 0) {
      setMsg(`Please fill in your ${humanList(missing)}.`, "err");
      return;
    }
    if (kind === "contact" && !payload.website) {
      if (!recaptchaToken) {
        const recoveryMessage =
          recaptchaState === "loading"
            ? RECAPTCHA_LOADING
            : recaptchaState === "expired"
              ? RECAPTCHA_EXPIRED
              : recaptchaState === "unavailable"
                ? RECAPTCHA_UNAVAILABLE
                : RECAPTCHA_MISSING;
        setMsg(recoveryMessage, "err");
        return;
      }
      payload.recaptchaToken = recaptchaToken;
    }

    const originalButtonHtml = button ? button.innerHTML : "";
    if (button) {
      button.disabled = true;
      button.textContent = "Sending…";
    }
    setMsg("Sending…", "");

    void fetch(INQUIRY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new InquiryRequestError(body?.error, response.status);
        }
        form.reset();
        if (kind === "contact") resetRecaptcha();
        setMsg(form.getAttribute("data-success") || DEFAULT_SUCCESS, "ok");
      })
      .catch((error: unknown) => {
        if (kind === "contact") resetRecaptcha();
        if (error instanceof InquiryRequestError && error.serverMessage) {
          setMsg(error.serverMessage, "err");
          return;
        }
        const detail =
          error instanceof Error && error.message ? ` (${error.message})` : "";
        setMsg(
          `Something went wrong sending your message${detail}. Please try again.`,
          "err",
        );
      })
      .finally(() => {
        if (button) {
          button.disabled = false;
          button.innerHTML = originalButtonHtml;
        }
      });
  });
}

/** Wires every `form[data-nb-inquiry]` on the page (0..n). */
export function initInquiryForms(): void {
  document
    .querySelectorAll<HTMLFormElement>("form[data-nb-inquiry]")
    .forEach(wireForm);
}
