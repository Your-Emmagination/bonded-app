// cloudflare/ai-worker/src/linkModeration.js
//
// URL rules for the moderation pipeline, alongside keywordModeration.js.
//
// Why here and not in each screen: posts, comments, replies, polls and
// community messages all funnel through the same moderateFirestoreContent()
// call, so one check here covers every surface at once and none of them can
// be bypassed by a patched client.
//
// No external service. OpenModeration scores text for harm and has nothing to
// say about where a URL leads; a reputation API would mean a key, a quota, a
// per-post subrequest and a dependency that fails closed or open at the worst
// time. These are string rules over a domain list: free, instant, offline,
// and explainable to a moderator reading the queue.
//
// The app carries a smaller copy of the same idea in utils/externalLinks.ts
// for the confirmation dialog at tap time. That one protects the reader; this
// one keeps the content from ever being published. Both are needed: this
// cannot see a domain nobody has listed, and that one only helps the person
// who stops to read it.

// Adult hosts. Registered-domain matches, so every subdomain is covered.
const ADULT_HOSTS = new Set([
  "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "redtube.com",
  "youporn.com", "spankbang.com", "brazzers.com", "onlyfans.com",
  "chaturbate.com", "stripchat.com", "bongacams.com", "livejasmin.com",
  "rule34.xxx", "e-hentai.org", "nhentai.net", "hanime.tv", "javhd.com",
  "porntrex.com", "eporner.com", "tnaflix.com", "motherless.com",
  "thisav.com", "iwara.tv", "fapello.com", "erome.com", "xhamster18.com",
  "hentaihaven.xxx", "pornhd.com", "youjizz.com", "tube8.com", "beeg.com",
  // Filipino viral scandal / leak domains
  "sulasok.mom",
]);

// Hidden destinations. Never conclusive on their own — a club really might
// share a bit.ly — which is why these queue for review rather than reject.
const SHORTENER_HOSTS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly",
  "cutt.ly", "shorturl.at", "rb.gy", "rebrand.ly", "bl.ink", "s.id",
  "tiny.cc", "t.ly", "short.io", "adf.ly", "shorte.st", "bc.vc", "linkbucks.com",
]);

// Everyday schoolwork destinations. Without these the queue fills with Drive
// links and moderators learn to approve without looking, which is worse than
// not checking at all.
const TRUSTED_HOSTS = new Set([
  "google.com", "forms.gle", "goo.gle", "youtube.com", "youtu.be",
  "facebook.com", "messenger.com", "fb.com", "instagram.com", "twitter.com",
  "x.com", "tiktok.com", "github.com", "wikipedia.org", "canva.com",
  "zoom.us", "microsoft.com", "office.com", "outlook.com", "live.com",
  "cloudinary.com", "spotify.com", "gmail.com", "adobe.com",
]);

const CAMPUS_TERMS = ["csap", "bonded"];
const CAMPUS_HOSTS = new Set(["csap.edu.ph", "bonded.csap"]);

const CREDENTIAL_BAIT = [
  "login", "signin", "sign-in", "verify", "verification", "account",
  "password", "reset", "claim", "confirm", "secure", "update", "grades",
];

// Free registrars that legitimate campus content essentially never uses, and
// that throwaway phishing sites essentially always do.
const THROWAWAY_TLDS = [".tk", ".ml", ".ga", ".cf", ".gq", ".xyz", ".top", ".click"];

const IPV4_HOST = /^\d{1,3}(\.\d{1,3}){3}$/;

// Two shapes, because people paste both.
//
// The first is an explicit URL. The second is a bare "host/path" with no
// scheme — "bit.ly/3xK9pQ", which is how a shortener is almost always pasted
// and which the scheme-only pattern missed entirely.
//
// The bare form requires a slash and a path, and requires the label before
// that slash to be at least two letters. Without those two conditions it
// matches ordinary writing: "3.5/10" becomes a host, and so does "Node.js".
const URL_PATTERN =
  /(?:https?:\/\/|www\.)[^\s<>"')\]]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s<>"')\]]*/gi;

// File extensions that look like a TLD to the bare-host pattern. Without this
// "report.pdf/final" is read as a host called report.pdf. It never flagged
// anything, but a filename like "grades.doc/login" would have tripped the
// sign-in rule, so they are dropped before any rule sees them.
const FILE_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "zip",
  "rar", "jpg", "jpeg", "png", "gif", "webp", "mp3", "mp4", "mov", "avi",
  "js", "ts", "tsx", "py", "java", "html", "css", "json", "xml", "exe", "apk",
]);

/** Every URL in a block of text, normalised and de-duplicated. */
export function extractUrls(text) {
  const found = String(text || "").match(URL_PATTERN) || [];
  const urls = [];

  for (const raw of found) {
    // Trailing punctuation belongs to the sentence, not the address.
    const trimmed = raw.replace(/[.,!?;:'"]+$/, "");
    const explicit = /^https?:\/\//i.test(trimmed);

    if (!explicit) {
      // A bare host whose last label is a file extension is a filename.
      const host = trimmed.split("/")[0].toLowerCase();
      const lastLabel = host.split(".").pop();
      if (FILE_EXTENSIONS.has(lastLabel)) continue;
    }

    urls.push(explicit ? trimmed : `https://${trimmed}`);
  }

  return Array.from(new Set(urls));
}

function hostOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function pathOf(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

// Keeps the last two labels, or three for the two-part suffixes this campus
// actually sees. A full public-suffix list would be more correct and far
// heavier than a review hint warrants.
function registeredDomain(host) {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;

  const twoPart = ["com.ph", "edu.ph", "net.ph", "org.ph", "gov.ph", "co.uk", "ac.uk"];
  const lastTwo = labels.slice(-2).join(".");
  if (twoPart.includes(lastTwo)) return labels.slice(-3).join(".");

  return lastTwo;
}

function listed(host, list) {
  return list.has(host) || list.has(registeredDomain(host));
}

/**
 * Judges every URL in a piece of content.
 *
 * Returns { flagged, matches, priority }, shaped like checkKeywordFlags() so
 * the caller can merge the two without special-casing either.
 *
 * `priority: "critical"` is used only for adult hosts — not because they are
 * dangerous the way self-harm is, but because no moderator should have to sit
 * with one in a queue. It puts them at the top to be cleared immediately.
 */
export function checkLinkFlags(text) {
  const matches = [];
  const urls = extractUrls(text);

  for (const url of urls) {
    const host = hostOf(url);
    if (!host) continue;
    if (listed(host, TRUSTED_HOSTS) || listed(host, CAMPUS_HOSTS)) continue;

    const domain = registeredDomain(host);
    const path = pathOf(url);

    if (listed(host, ADULT_HOSTS)) {
      matches.push({
        category: "adult_link",
        label: "Link to an adult site",
        host,
        priority: "critical",
      });
      // Nothing else about this link matters once it is this.
      continue;
    }

    if (IPV4_HOST.test(host)) {
      matches.push({
        category: "ip_link",
        label: "Link to a raw IP address",
        host,
      });
    }

    if (listed(host, SHORTENER_HOSTS)) {
      matches.push({
        category: "shortened_link",
        label: "Shortened link hiding its destination",
        host,
      });
    }

    // The school's name on a domain the school does not own.
    if (CAMPUS_TERMS.some((term) => domain.includes(term)) && !CAMPUS_HOSTS.has(domain)) {
      matches.push({
        category: "lookalike_link",
        label: "Link imitating an official school address",
        host,
      });
    }

    // Sign-in wording somewhere that is not the school.
    if (CREDENTIAL_BAIT.some((word) => path.includes(word))) {
      matches.push({
        category: "credential_link",
        label: "Link to a sign-in page outside the school",
        host,
      });
    }

    if (THROWAWAY_TLDS.some((tld) => domain.endsWith(tld))) {
      matches.push({
        category: "throwaway_link",
        label: "Link on a free throwaway domain",
        host,
      });
    }
  }

  const priority = matches.some((match) => match.priority === "critical")
    ? "critical"
    : "normal";

  return { flagged: matches.length > 0, matches, priority };
}
