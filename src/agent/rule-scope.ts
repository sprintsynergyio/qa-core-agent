/**
 * A rule that names a page or a form ("the home page", "the registration
 * form") can only be verified on that page. Run 8 and run 9 credited R12
 * ("Submitting the registration form with an empty required field ...") to
 * tests planned on /auth/login, and R1 ("The home page lists products ...")
 * to a price sort on /category/hand-tools, so rule coverage counted rules no
 * test exercised (D8a in docs/audit/run-71d739-diagnosis.md and
 * run-b4e41b-diagnosis.md).
 *
 * pageScopeMismatchReason reads the places a rule names from the rule text
 * (the requirements map, never a scenario name) and asks whether the planned
 * page carries at least one of them by page evidence: its path segments
 * (the same token table the page filter uses) or one of its h1 headings. A
 * rule may name a destination too ("... and the user stays on the login
 * page"), so ANY named place is enough. A word the table does not know
 * ("its detail page") is never judged. The check only ever removes a
 * citation, never a scenario, so a miss reads as an uncovered rule, never as
 * a covered one.
 */
import { segmentMatchesTokens, tokensFor } from './page-filter.js';

/** A place a rule can name, with the path tokens that carry it. */
interface PlaceName {
  re: RegExp;
  /** The words the console line uses. */
  label: string;
  /** null means the home page: the root path. */
  feature: string | null;
}

const PAGE_WORD = String.raw`\s+(?:page|form|screen)\b`;

const PLACES: PlaceName[] = [
  { re: new RegExp(String.raw`\b(?:home|landing)${PAGE_WORD}|\bhomepage\b`, 'i'), label: 'the home page', feature: null },
  { re: new RegExp(String.raw`\b(?:registration|register|sign[- ]?up)${PAGE_WORD}`, 'i'), label: 'the registration form', feature: 'registration' },
  { re: new RegExp(String.raw`\b(?:login|log[- ]?in|sign[- ]?in)${PAGE_WORD}`, 'i'), label: 'the login page', feature: 'login' },
  { re: new RegExp(String.raw`\b(?:forgot[- ]password|password[- ]reset|reset[- ]password|password[- ]recovery)${PAGE_WORD}`, 'i'), label: 'the password reset page', feature: 'password-recovery' },
  { re: new RegExp(String.raw`\bcontact${PAGE_WORD}`, 'i'), label: 'the contact form', feature: 'contact' },
  { re: new RegExp(String.raw`\b(?:cart|basket)${PAGE_WORD}`, 'i'), label: 'the cart page', feature: 'cart' },
  { re: new RegExp(String.raw`\bcheckout${PAGE_WORD}`, 'i'), label: 'the checkout page', feature: 'checkout' },
  { re: new RegExp(String.raw`\bsearch(?:\s+results)?${PAGE_WORD}`, 'i'), label: 'the search page', feature: 'search' },
];

/**
 * A place named as where the flow ENDS ("redirects to the login page",
 * "is taken to the cart page") is reached after the action, so it says
 * nothing about where the test starts and is not judged. "Stays on the login
 * page" is where the test runs and is judged.
 */
const DESTINATION_BEFORE_RE = /\b(?:redirect(?:s|ed)?|tak(?:es|en)|land(?:s|ed)?|navigat(?:es|ed)|go(?:es)?|return(?:s|ed)?|open(?:s|ed)?|sen(?:ds|t)|bring(?:s)?|brought|lead(?:s)?|led)\b[^.]{0,24}$/i;

/**
 * The places a rule's text names as where it is tested, in table order;
 * a place named only as a destination is left out. Exported for the smoke.
 */
export function namedPlaces(ruleText: string): Array<{ label: string; feature: string | null }> {
  const out: Array<{ label: string; feature: string | null }> = [];
  for (const p of PLACES) {
    const re = new RegExp(p.re.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(ruleText)) !== null) {
      if (!DESTINATION_BEFORE_RE.test(ruleText.slice(0, m.index))) {
        out.push({ label: p.label, feature: p.feature });
        break;
      }
    }
  }
  return out;
}

/** What the planned page shows: its URL and its h1 headings. */
export interface PlannedPageEvidence {
  url: string;
  h1?: string[];
}

function segmentsOf(url: string): string[] | null {
  try {
    return new URL(url).pathname.toLowerCase().split('/').filter(Boolean);
  } catch {
    return null;
  }
}

const HOME_SEGMENTS = new Set(['home', 'index', 'index.html', 'index.htm']);

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url;
  }
}

function carries(place: { feature: string | null }, page: PlannedPageEvidence): boolean {
  const segs = segmentsOf(page.url);
  if (segs === null) return true; // an unparseable URL is never judged
  if (place.feature === null) return segs.length === 0 || (segs.length === 1 && HOME_SEGMENTS.has(segs[0]!));
  const tokens = tokensFor(place.feature);
  if (segs.some((seg) => segmentMatchesTokens(seg, tokens))) return true;
  const words = tokens.map((t) => t.replace(/[-_]/g, ' '));
  return (page.h1 ?? []).some((h) => {
    const text = h.toLowerCase().replace(/[-_]/g, ' ');
    return words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
  });
}

/**
 * True when the scenario's own name says it goes to the place: the place's
 * phrase anywhere in it ("opened the cart page from the header"), or, for
 * any place but the home page, one of the feature's tokens as a whole word
 * ("added an item and opened the cart"). A scenario planned on the home
 * page that clicks through to the cart verifies a cart-page rule; a login
 * test whose name never mentions registration does not verify a
 * registration rule. A word match on the plan's own name, never an exact
 * string (standing rule 1).
 */
function nameReaches(place: { label: string; feature: string | null }, name: string): boolean {
  const entry = PLACES.find((p) => p.label === place.label);
  if (entry && new RegExp(entry.re.source, 'i').test(name)) return true;
  if (place.feature === null) return false;
  const text = name.toLowerCase().replace(/[-_]/g, ' ');
  return tokensFor(place.feature).some((t) => new RegExp(`\\b${t.replace(/[-_]/g, ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
}

/**
 * Why a citation of this rule cannot be verified by this scenario on this
 * page, or null. Null when the rule names no place the table knows, when
 * the page carries at least one of the places it names, or when the
 * scenario's name says it goes to one of them.
 */
export function pageScopeMismatchReason(ruleText: string, page: PlannedPageEvidence, scenarioName?: string): string | null {
  const places = namedPlaces(ruleText);
  if (places.length === 0) return null;
  if (places.some((p) => carries(p, page))) return null;
  if (scenarioName !== undefined && places.some((p) => nameReaches(p, scenarioName))) return null;
  const names = places.map((p) => p.label).join(' or ');
  return `the rule names ${names} and this scenario is planned on ${pathOf(page.url)}, which does not carry it by page evidence`;
}
