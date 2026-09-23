// utils/externalLinks.ts
//
// One place that decides what happens when a link in BondED is tapped.
//
// Before this, eight screens called Linking.openURL() directly: a tap went
// straight to the browser with nothing in between and no way to add anything
// later. Everything here is local — a domain list and string rules, no API,
// no network call, no key to manage. That matters for a campus app: the check
// still works on a bad connection, costs nothing per link, and cannot leak
// what students are reading to a third party.
//
// The server does the same job again in cloudflare/ai-worker/src/
// linkModeration.js when content is posted. This copy is the one that guards
// the tap; that one is the one a student cannot bypass. Neither replaces the
// other.

export type LinkRisk =
  /** Never open. Adult sites and known-bad hosts. */
  | "blocked"
  /** Open only after the person has seen where it really goes. */
  | "suspicious"
  /** Nothing known against it — still shows the destination. */
  | "unknown"
  /** Campus-owned or a well-known service students use daily. */
  | "trusted";

export type LinkVerdict = {
  risk: LinkRisk;
  /** Registered domain, for display. "" when the URL could not be parsed. */
  host: string;
  /** Plain-language reasons, shown to the person. Empty for trusted/unknown. */
  reasons: string[];
};

// Adult hosts. Deliberately short: this is the tap-time guard, and shipping a
// 200,000-entry blocklist into the app bundle would cost every student
// megabytes to catch names the worker already covers server-side. These are
// the ones common enough to be worth catching on the device itself.
const ADULT_HOSTS = new Set([
  "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "redtube.com",
  "youporn.com", "spankbang.com", "brazzers.com", "onlyfans.com",
  "chaturbate.com", "stripchat.com", "bongacams.com", "livejasmin.com",
  "rule34.xxx", "e-hentai.org", "nhentai.net", "hanime.tv", "javhd.com",
  "porntrex.com", "eporner.com", "tnaflix.com", "motherless.com",
  "thisav.com", "iwara.tv", "fapello.com", "erome.com",
  // Filipino viral scandal / leak domains
  "sulasok.mom",
]);

// Link shorteners. Not bad in themselves — bad because they hide the
// destination, which is the one thing the confirmation dialog exists to show.
const SHORTENER_HOSTS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly",
  "cutt.ly", "shorturl.at", "rb.gy", "rebrand.ly", "bl.ink", "s.id",
  "tiny.cc", "lnkd.in", "t.ly", "short.io", "adf.ly", "shorte.st",
]);

// Services students genuinely use for schoolwork every day, plus the app's
// own media host. Listing them keeps the dialog from crying wolf on the
// hundred harmless Drive and YouTube links shared each week — a warning that
// appears on everything is a warning nobody reads.
const TRUSTED_HOSTS = new Set([
  "google.com", "docs.google.com", "drive.google.com", "forms.gle",
  "classroom.google.com", "meet.google.com", "goo.gle",
  "youtube.com", "youtu.be", "facebook.com", "messenger.com", "fb.com",
  "instagram.com", "twitter.com", "x.com", "tiktok.com",
  "github.com", "wikipedia.org", "canva.com", "zoom.us",
  "microsoft.com", "office.com", "outlook.com", "onedrive.live.com",
  "cloudinary.com", "res.cloudinary.com",
]);

// The campus's own names. Anything that puts these in a domain it does not
// own is impersonating the school — the exact shape of the phishing that
// matters here ("csap-enrollment-verify.tk").
const CAMPUS_TERMS = ["csap", "bonded"];
const CAMPUS_HOSTS = new Set(["csap.edu.ph", "bonded.csap"]);

// Words that belong to a sign-in page. Harmless on the school's own domain,
// a strong signal anywhere else.
const CREDENTIAL_BAIT = [
  "login", "signin", "sign-in", "verify", "verification", "account",
  "password", "reset", "claim", "confirm", "secure", "update",
];

const IPV4_HOST = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Strips "www." and lowercases. Returns "" when the URL will not parse. */
export function getHost(url: string): string {
  try {
    const parsed = new URL(String(url || "").trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * The registered domain, roughly — "docs.google.com" becomes "google.com" so
 * a subdomain of a trusted service is still trusted.
 *
 * Deliberately simple: it keeps the last two labels, or three for the
 * two-part country suffixes this campus actually sees (.com.ph, .edu.ph,
 * .co.uk). A full public-suffix list would be more correct and far larger
 * than this is worth — and a mistake here only changes which name the dialog
 * shows, never whether the dialog appears.
 */
export function getRegisteredDomain(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;

  const twoPartSuffixes = ["com.ph", "edu.ph", "net.ph", "org.ph", "gov.ph", "co.uk", "ac.uk"];
  const lastTwo = labels.slice(-2).join(".");
  if (twoPartSuffixes.includes(lastTwo)) return labels.slice(-3).join(".");

  return lastTwo;
}

function isListed(host: string, list: Set<string>): boolean {
  if (list.has(host)) return true;
  const registered = getRegisteredDomain(host);
  return list.has(registered);
}

/**
 * Judges one link.
 *
 * `label` is the text shown in place of the URL — a post's link title, say.
 * When it names a different site than the link actually goes to, that is
 * deliberate misdirection and worth saying out loud.
 */
export function analyzeLink(url: string, label?: string): LinkVerdict {
  const host = getHost(url);
  if (!host) return { risk: "blocked", host: "", reasons: ["This link is malformed."] };

  const reasons: string[] = [];

  if (isListed(host, ADULT_HOSTS)) {
    return {
      risk: "blocked",
      host,
      reasons: ["This is an adult site. Links like this aren't allowed on BondED."],
    };
  }

  if (isListed(host, TRUSTED_HOSTS) || isListed(host, CAMPUS_HOSTS)) {
    return { risk: "trusted", host, reasons: [] };
  }

  if (IPV4_HOST.test(host)) {
    reasons.push("This link points at a raw IP address instead of a website name.");
  }

  if (isListed(host, SHORTENER_HOSTS)) {
    reasons.push("This is a shortened link — its real destination is hidden.");
  }

  // Impersonation: the campus name on a domain the campus does not own.
  const registered = getRegisteredDomain(host);
  if (
    CAMPUS_TERMS.some((term) => registered.includes(term)) &&
    !CAMPUS_HOSTS.has(registered)
  ) {
    reasons.push("This site uses the school's name but isn't an official school site.");
  }

  // Sign-in wording on somebody else's domain.
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (CREDENTIAL_BAIT.some((word) => path.includes(word))) {
    reasons.push("This page asks you to sign in, and it isn't a school site.");
  }

  // The label names one site, the link goes to another.
  if (label) {
    const labelHost = getHost(label.trim().startsWith("http") ? label : `https://${label}`);
    if (labelHost && getRegisteredDomain(labelHost) !== registered) {
      reasons.push(`The link says “${labelHost}” but goes to “${host}”.`);
    }
  }

  return { risk: reasons.length ? "suspicious" : "unknown", host, reasons };
}

/**
 * Whether a link may be sent at all — used before a direct message goes out.
 *
 * Private messages are never read by moderation and never seen by staff, so
 * the only thing checked here is the domain. No message text is inspected,
 * nothing is logged, and only an outright blocked host stops the send.
 */
export function findBlockedLink(urls: string[]): { url: string; host: string } | null {
  for (const url of urls) {
    const verdict = analyzeLink(url);
    if (verdict.risk === "blocked" && verdict.host) {
      return { url, host: verdict.host };
    }
  }
  return null;
}
