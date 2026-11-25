import type { Assertion, SelectorRecord, TraceStep } from './trace.js';

/**
 * Claims and evidence (invariant 89).
 *
 * A test name, or a requirement rule, says what is checked: "with names,
 * images, and prices", "matching name and price", "the line total updated",
 * "rejected". The recording holds what was checked. This module reads both
 * and names every claim the recording does not back.
 *
 * Run 10 (ceeaf2) shipped three tests whose names claimed more than their
 * recordings proved, and counted R5, R7 and R9 as covered while the citing
 * tests exercised part of each (docs/audit/run-ceeaf2-diagnosis.md, D3 and
 * line 8). The Critic passed all of them.
 *
 * The claim side reads a small fixed vocabulary out of the plan's name or the
 * rule text (words, never an exact string). The evidence side reads only what
 * the engine recorded: the step kinds, the assertion types, the locators and
 * the patterns. A step's intent is model text and is never read.
 *
 * The vocabulary is small on purpose. A phrase it does not know is no claim,
 * so an unknown wording is never refused.
 */

export type ClaimKind = 'name' | 'price' | 'image' | 'total' | 'quantity' | 'count' | 'error' | 'rejection';

/**
 * What a claim needs from the recording: `read` (a check reads the thing),
 * `equal` (a compare proves two reads are the same value), or `outcome` (a
 * check that could not have held before the last action).
 */
export type ClaimNeed = 'read' | 'equal' | 'outcome';

export interface Claim {
  kind: ClaimKind;
  need: ClaimNeed;
  /** The words of the text that make the claim, for the message. */
  phrase: string;
}

export interface ClaimGap extends Claim {
  /** What the recording lacks, in plain words. */
  missing: string;
  /** How to close the gap, for the Explorer. */
  steer: string;
}

/** Where the text comes from: a scenario's planned name, or a requirement rule. */
export type ClaimSource = 'name' | 'rule';

const KIND_WORDS: Record<string, ClaimKind> = {
  name: 'name', names: 'name', title: 'name', titles: 'name',
  price: 'price', prices: 'price',
  image: 'image', images: 'image', picture: 'image', pictures: 'image', photo: 'image', photos: 'image', thumbnail: 'image', thumbnails: 'image',
  total: 'total', totals: 'total', subtotal: 'total',
  quantity: 'quantity', quantities: 'quantity', qty: 'quantity',
  count: 'count', counter: 'count', badge: 'count',
  error: 'error', errors: 'error',
};

// A word before "message" that makes it an error message. "message" alone is
// a form field as often as not ("valid message and email"), so it is no claim.
const MESSAGE_QUALIFIERS = new Set(['error', 'validation', 'required-field', 'warning', 'failure']);

// "first name", "user name": a form field, never a displayed name.
const NAME_FIELD_QUALIFIERS = new Set(['first', 'last', 'user', 'full', 'given', 'family', 'middle', 'company', 'card', 'file', 'display', 'account', 'sur', 'field']);

// Words that open a list of displayed or resulting things.
const TRIGGERS = new Set([
  'with', 'showing', 'shows', 'show', 'showed', 'displays', 'displayed', 'displaying', 'lists', 'listed', 'saw', 'sees',
  'matching', 'same', 'updates', 'updated', 'update', 'increases', 'increased', 'decreases', 'decreased', 'recalculates', 'recalculated',
]);

// Words a list may hold between its things.
const LIST_SKIP = new Set([
  'a', 'an', 'the', 'its', 'their', 'each', 'every', 'all', 'both', 'and', 'or', 'correct', 'right', 'new', 'line', 'unit', 'cart',
  'product', 'products', 'item', 'items', 'header', 'visible', 'inline', 'required-field', 'validation', 'of', 'matching', 'same', 'own',
]);

// Verbs that, right after a thing, say it changed or was shown.
const OUTCOME_VERBS = new Set([
  'updated', 'updates', 'increased', 'increases', 'decreased', 'decreases', 'recalculated', 'recalculates', 'changed', 'changes',
  'matched', 'matches', 'appeared', 'appears', 'displayed', 'shown', 'showed',
]);
const EQUAL_VERBS = new Set(['matched', 'matches']);
// Words that may sit between a thing and its verb: "cart count in header increased".
const BETWEEN_THING_AND_VERB = new Set(['in', 'on', 'the', 'header', 'page', 'cell', 'badge', 'was', 'is', 'were', 'are', 'has', 'have']);

const REJECTION_RE = /\b(?:reject(?:s|ed|ion)?|refus(?:es|ed)|denie[sd]|declin(?:es|ed))\b/;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/required[\s-]+field/g, 'required-field')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** The kind a token names at position i, or null. */
function kindAt(toks: string[], i: number): ClaimKind | null {
  const t = toks[i]!;
  if ((t === 'message' || t === 'messages') && i > 0 && MESSAGE_QUALIFIERS.has(toks[i - 1]!)) return 'error';
  const kind = KIND_WORDS[t];
  if (!kind) return null;
  if (kind === 'name' && ((i > 0 && NAME_FIELD_QUALIFIERS.has(toks[i - 1]!)) || NAME_FIELD_QUALIFIERS.has(toks[i + 1] ?? ''))) return null;
  // "error message": one claim, made by the word "message".
  if (kind === 'error' && (toks[i + 1] === 'message' || toks[i + 1] === 'messages')) return null;
  return kind;
}

/**
 * The claims a text makes. Two shapes are read:
 *
 *  - a list after a lead-in word: "with names, images, and prices", "showing
 *    the same name and price", "updates the line total", "saw a
 *    required-field error". "matching" or "same" in the list makes every
 *    thing after it an `equal` claim.
 *  - a thing followed by a verb: "the line total updated", "cart count in
 *    header increased".
 *
 * A thing that is only acted on ("sorted by price", "changed quantity") is
 * no claim. A rejection word ("rejected", "refuses") is one `outcome` claim.
 */
export function claimsIn(text: string): Claim[] {
  const toks = tokens(text);
  const found = new Map<string, Claim>();
  const add = (kind: ClaimKind, need: ClaimNeed, phrase: string): void => {
    const key = `${kind}:${need}`;
    // An equal claim on a kind covers a read claim on it.
    if (need === 'read' && found.has(`${kind}:equal`)) return;
    if (need === 'equal') found.delete(`${kind}:read`);
    if (!found.has(key)) found.set(key, { kind, need, phrase });
  };

  for (let i = 0; i < toks.length; i++) {
    if (!TRIGGERS.has(toks[i]!)) continue;
    // "only matching product names": the products that match a search, not two reads of one value.
    if ((toks[i] === 'matching' || toks[i] === 'same') && i > 0 && toks[i - 1] === 'only') continue;
    let need: ClaimNeed = toks[i] === 'matching' || toks[i] === 'same' ? 'equal' : 'read';
    const picked: Array<{ kind: ClaimKind; need: ClaimNeed }> = [];
    let end = i;
    for (let j = i + 1; j < toks.length && j <= i + 10; j++) {
      const t = toks[j]!;
      const kind = kindAt(toks, j);
      if (kind) { picked.push({ kind, need }); end = j; continue; }
      if (t === 'matching' || t === 'same') { need = 'equal'; continue; }
      if (t === 'message' || t === 'messages' || t === 'error') continue;
      if (LIST_SKIP.has(t)) continue;
      break;
    }
    const phrase = toks.slice(i, end + 1).join(' ');
    for (const p of picked) add(p.kind, p.need, phrase);
  }

  for (let i = 0; i < toks.length; i++) {
    const kind = kindAt(toks, i);
    if (!kind) continue;
    for (let j = i + 1; j < toks.length && j <= i + 3; j++) {
      if (OUTCOME_VERBS.has(toks[j]!)) {
        add(kind, EQUAL_VERBS.has(toks[j]!) ? 'equal' : 'read', toks.slice(i, j + 1).join(' '));
        break;
      }
      // "searched for a product name and results showed": the verb belongs to another thing.
      if (!BETWEEN_THING_AND_VERB.has(toks[j]!)) break;
    }
  }

  const rejection = REJECTION_RE.exec(text.toLowerCase());
  if (rejection) add('rejection', 'outcome', rejection[0]);
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Evidence: what the recording holds.
// ---------------------------------------------------------------------------

/** The words a locator is built from: css, test id, label or text, or the role and its name. Never the intent. */
function locatorRaw(t: SelectorRecord): string {
  if (t.level !== 'role') return String(t.arg);
  const a = t.arg as { role: string; name?: string };
  return `${a.role} ${a.name ?? ''}`;
}

function locatorWords(t: SelectorRecord): string[] {
  return locatorRaw(t).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const NAME_LOCATOR = new Set(['name', 'names', 'title', 'titles', 'heading', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
// "first-name", "last_name", "username": a form field's own name, never a displayed name.
const NAME_FIELD_LOCATOR_RE = /(?:first|last|user|full|sur|company|given|family)[\s_-]*name/i;
const PRICE_LOCATOR = new Set(['price', 'prices', 'cost', 'amount', 'total', 'subtotal']);
const TOTAL_LOCATOR = new Set(['total', 'totals', 'subtotal', 'sum', 'price', 'prices', 'amount']);
const IMAGE_LOCATOR = new Set(['img', 'image', 'images', 'picture', 'photo', 'thumbnail', 'thumb']);
const QUANTITY_LOCATOR = new Set(['quantity', 'quantities', 'qty']);
const COUNT_LOCATOR = new Set(['count', 'counter', 'badge', 'quantity', 'qty']);
const FIELD_LOCATOR = new Set(['input', 'textarea', 'select', 'textbox', 'combobox', 'checkbox', 'radio', 'button', 'spinbutton', 'searchbox']);

/** The kinds a locator names by its own structure. */
export function locatorKinds(t: SelectorRecord): Set<ClaimKind> {
  const words = locatorWords(t);
  const has = (set: Set<string>): boolean => words.some((w) => set.has(w));
  const kinds = new Set<ClaimKind>();
  if (has(NAME_LOCATOR) && !NAME_FIELD_LOCATOR_RE.test(locatorRaw(t))) kinds.add('name');
  if (has(PRICE_LOCATOR)) kinds.add('price');
  if (has(TOTAL_LOCATOR)) kinds.add('total');
  if (has(IMAGE_LOCATOR)) kinds.add('image');
  if (has(QUANTITY_LOCATOR)) kinds.add('quantity');
  if (has(COUNT_LOCATOR)) kinds.add('count');
  return kinds;
}

// A price pattern: a currency symbol, or digits, a dot and digits.
const PRICE_PATTERN_RE = /\\\$|[$€£¥]|\\d[+*]?(?:\{\d+(?:,\d*)?\})?\\\.\\d/;

function assertionTarget(a: Assertion): SelectorRecord | null {
  return 'target' in a ? a.target : null;
}

function sameElement(x: SelectorRecord, y: SelectorRecord): boolean {
  if (x.elementKey && y.elementKey) return x.elementKey === y.elementKey;
  return x.level === y.level && JSON.stringify(x.arg) === JSON.stringify(y.arg);
}

function isAction(s: TraceStep): boolean {
  return s.kind === 'click' || s.kind === 'fill' || s.kind === 'press' || s.kind === 'select_option' || s.kind === 'set_checked' || s.kind === 'set_input_files';
}

/** A locator that is a form control: its visibility or state says nothing about a message. */
function isFieldLocator(t: SelectorRecord): boolean {
  if (t.level === 'label' || t.level === 'placeholder') return true;
  if (t.level === 'role') return FIELD_LOCATOR.has((t.arg as { role: string }).role);
  if (t.level !== 'css') return false;
  // The last simple selector decides: "form .error" is a message, "input#email" is a field.
  const last = String(t.arg).split(',')[0]!.trim().split(/[\s>+~]+/).pop() ?? '';
  const tag = /^[a-z]+/i.exec(last)?.[0]?.toLowerCase() ?? '';
  return FIELD_LOCATOR.has(tag);
}

export interface Evidence {
  /** Kinds a check read: an assertion on it, or a capture a compare used. */
  read: Set<ClaimKind>;
  /** Kinds an equal or unchanged compare proved the same across two reads. */
  equal: Set<ClaimKind>;
  /** Kinds a step acted on (typed into, clicked, selected). */
  acted: Set<ClaimKind>;
  /** A visible or text check, after the last action, on an element that is not a form control the scenario used. */
  errorRead: boolean;
  /** A check, after the last action, that could not have held before it. */
  outcome: boolean;
}

/**
 * What the recorded steps prove, read off engine data only.
 *
 * A check counts toward `outcome` and `errorRead` only when it comes after
 * the last action and is none of: a URL check (the page a failed submit
 * stays on is the page it was on), an absence (nothing was there before
 * either), or any check on an element the scenario acted on (typing an
 * invalid value sets aria-invalid before any submit; run 10's "rejected a
 * malformed email format").
 */
export function evidenceIn(steps: TraceStep[]): Evidence {
  const ev: Evidence = { read: new Set(), equal: new Set(), acted: new Set(), errorRead: false, outcome: false };
  const captures = new Map<string, SelectorRecord>();
  const actedOn: SelectorRecord[] = [];
  let lastAction = -1;
  steps.forEach((s, i) => { if (isAction(s)) lastAction = i; });

  const addAll = (into: Set<ClaimKind>, from: Iterable<ClaimKind>): void => { for (const k of from) into.add(k); };

  steps.forEach((s, i) => {
    if (isAction(s) && 'target' in s && s.target) {
      actedOn.push(s.target);
      addAll(ev.acted, locatorKinds(s.target));
      return;
    }
    if (s.kind === 'capture') {
      captures.set(s.varName, s.target);
      return;
    }
    if (s.kind === 'assert_compare') {
      const from = captures.get(s.varName);
      const reread = s.readTarget ?? s.target;
      const kinds = new Set<ClaimKind>([...(from ? locatorKinds(from) : []), ...locatorKinds(reread)]);
      addAll(ev.read, kinds);
      if (s.relation === 'equal' || s.relation === 'unchanged') addAll(ev.equal, kinds);
      // A greater or less compare is a number read twice: a count or a total moved.
      if (s.relation === 'greater' || s.relation === 'less') { ev.read.add('count'); }
      if (i > lastAction && lastAction >= 0) ev.outcome = true;
      return;
    }
    if (s.kind !== 'assert') return;
    const a = s.assertion;
    const target = assertionTarget(a);
    if (target) {
      const absence = a.type === 'toBeHidden' || (a.type === 'toHaveCount' && a.count === 0 && !a.atLeast);
      if (!absence) {
        addAll(ev.read, locatorKinds(target));
        if (a.type === 'allItemsMatch') ev.read.add('name');
        if (a.type === 'toHaveAttribute' && /^(?:src|srcset|alt)$/i.test(a.attribute)) ev.read.add('image');
        const pattern = 'pattern' in a && typeof a.pattern === 'string' ? a.pattern : '';
        if (a.type !== 'allItemsMatch' && pattern && PRICE_PATTERN_RE.test(pattern)) { ev.read.add('price'); ev.read.add('total'); }
      }
      if (absence || i <= lastAction) return;
      if (actedOn.some((t) => sameElement(t, target))) return;
      ev.outcome = true;
      if ((a.type === 'toBeVisible' || a.type === 'toHaveText' || a.type === 'toContainText') && !isFieldLocator(target)) ev.errorRead = true;
    }
  });
  return ev;
}

const KIND_LABEL: Record<ClaimKind, string> = {
  name: 'name', price: 'price', image: 'image', total: 'total', quantity: 'quantity', count: 'count', error: 'error message', rejection: 'rejection',
};

function gapFor(c: Claim, ev: Evidence, source: ClaimSource): ClaimGap | null {
  const label = KIND_LABEL[c.kind];
  if (c.kind === 'rejection') {
    if (ev.outcome) return null;
    return {
      ...c,
      missing: 'no check after the last action could fail if the submit were accepted',
      steer: 'assert the visible error message or alert the page shows after the submit (a URL that stays, and a state of the field that was typed into, hold before the submit too)',
    };
  }
  if (c.kind === 'error') {
    if (ev.errorRead) return null;
    return {
      ...c,
      missing: 'no check reads an error message after the last action',
      steer: 'assert the error element is visible, or its text with a pattern, after the submit',
    };
  }
  if (c.need === 'equal') {
    if (ev.equal.has(c.kind)) return null;
    return {
      ...c,
      missing: `no compare proves the ${label} is the same in both places`,
      steer: `capture the ${label} before the action, act, then assert_compare equal on the ${label} element of the page reached`,
    };
  }
  // A name may say a thing was typed or chosen ("with quantity 3"): acting on it is enough there. A rule's wording is held to a read.
  if (ev.read.has(c.kind) || (source === 'name' && ev.acted.has(c.kind))) return null;
  return {
    ...c,
    missing: `no check reads the ${label}`,
    steer: `add an assertion on the ${label} element itself (its text with a pattern, or a capture and assert_compare)`,
  };
}

/** Every claim of the text the recorded steps do not back. */
export function claimGaps(text: string, steps: TraceStep[], source: ClaimSource): ClaimGap[] {
  const claims = claimsIn(text);
  if (claims.length === 0) return [];
  const ev = evidenceIn(steps);
  return claims.map((c) => gapFor(c, ev, source)).filter((g): g is ClaimGap => g !== null);
}

/**
 * The gaps of a rule against every recording that cites it: a claim is
 * backed when at least one citing recording backs it.
 */
export function ruleClaimGaps(ruleText: string, recordings: TraceStep[][]): ClaimGap[] {
  const claims = claimsIn(ruleText);
  if (claims.length === 0 || recordings.length === 0) return [];
  const evs = recordings.map((steps) => evidenceIn(steps));
  return claims
    .map((c) => {
      let first: ClaimGap | null = null;
      for (const ev of evs) {
        const gap = gapFor(c, ev, 'rule');
        if (!gap) return null;
        first ??= gap;
      }
      return first;
    })
    .filter((g): g is ClaimGap => g !== null);
}

/** One line per gap: `"with names" (no check reads the name)`. */
export function gapText(g: ClaimGap): string {
  return `${JSON.stringify(g.phrase)} (${g.missing})`;
}
