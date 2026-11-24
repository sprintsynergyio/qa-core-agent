/**
 * Account safety behind the sign-in (invariant 88).
 *
 * A scenario planned on a page behind the sign-in runs on the ONE dedicated
 * test account, and every later stage (replay, stability, the emitted-spec
 * check) and every later run signs in with that same account. A scenario
 * that changes its password or its sign-in identifier, or removes it, breaks
 * all of them, the way a locked account does (invariant 70). Such a scenario
 * is never planned, and the tool refuses the step when one is recorded
 * anyway.
 *
 * The plan-time check reads the planned name by word pattern, never by an
 * exact string (standing rule 1); it is the cheap first line. The tool-side
 * check reads the page itself (the field's type and current value, the
 * control's own text) and is the one that decides.
 *
 * Not covered, by decision of scope: placing an order or paying while signed
 * in. A checkout test creates an order by nature; whether that is allowed on
 * a given account is the owner's call, not a rule of the engine.
 */

export type AccountChange = 'password' | 'identifier' | 'removal';

/** What a refusal says, per kind. */
export const ACCOUNT_SAFETY_REASONS: Record<AccountChange, string> = {
  password: 'would change the test account password',
  identifier: 'would change the test account sign-in identifier',
  removal: 'would remove the test account',
};

/** Lower-case words: camelCase split, every other character a space. */
function words(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const CHANGE_VERB = '(?:chang|updat|reset|modif|edit|replac)(?:e|es|ed|ing)?|sets?|setting';
const PASSWORD_RE = new RegExp(`\\b(?:${CHANGE_VERB})\\b(?: \\w+){0,3} password\\b`);
const NEW_PASSWORD_RE = /\bnew password\b/;
const IDENTIFIER_RE = new RegExp(`\\b(?:${CHANGE_VERB})\\b(?: \\w+){0,3} (?:e ?mail|username|user name|login name)\\b`);
const REMOVAL_RE = /\b(?:delet|clos|deactivat|remov|terminat)(?:e|es|ed|ing)?\b(?: \w+){0,2} account\b/;

/** The account change a text names, or null. Used on a planned name and on a control's own text. */
export function accountChangeIn(text: string): AccountChange | null {
  const w = words(text);
  if (REMOVAL_RE.test(w)) return 'removal';
  if (PASSWORD_RE.test(w) || NEW_PASSWORD_RE.test(w)) return 'password';
  if (IDENTIFIER_RE.test(w)) return 'identifier';
  return null;
}

/** Why a scenario planned behind the sign-in is never planned, or null. */
export function accountSafetyReason(name: string): string | null {
  const change = accountChangeIn(name);
  return change ? ACCOUNT_SAFETY_REASONS[change] : null;
}

/** The console line for a scenario dropped at plan time. */
export function accountSafetyLine(name: string, url: string, reason: string): string {
  return `Rejected account-safety scenario: "${name}" on ${url}: ${reason}; every later stage and run signs in with the same account`;
}

/** True when a control's own text names removing the account (the only click the tool refuses). */
export function removesAccount(controlText: string): boolean {
  return REMOVAL_RE.test(words(controlText));
}

/** The skip reason the tool records when it refuses a step. */
export function accountSafetySkipReason(change: AccountChange): string {
  return `account safety: ${ACCOUNT_SAFETY_REASONS[change]}`;
}
