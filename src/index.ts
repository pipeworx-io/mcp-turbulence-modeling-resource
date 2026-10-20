interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * NASA Langley Turbulence Modeling Resource (TMR) — verification and
 * validation cases for turbulence-model developers.
 *
 * Publisher: NASA Langley Research Center, Turbulence Modeling Resource.
 * US government work — public domain. The TMR catalogs the standard set of
 * 2D/3D/axisymmetric test cases the turbulence-modeling community uses to
 * check a CFD code's implementation of a turbulence model (verification)
 * and its ability to reproduce real flow physics (validation): flat
 * plates, bumps-in-channel, airfoils, jets, backward-facing steps,
 * shock/boundary-layer interactions, and more. Each case publishes flow
 * conditions, grids, and — for validation cases — reference data (usually
 * an experiment, occasionally a correlation or DNS) that a model's
 * prediction is checked against.
 *
 * CASE CATALOG: the ~34 entries in CASES below (ids, category, name, flow
 * conditions) are transcribed from the TMR's own case index and case pages
 * (tmbwg.github.io/turbmodels, the current home of what was
 * turbmodels.larc.nasa.gov). It is a small reference table — not a
 * generated corpus — so it is a plain module-level array rather than a
 * KV-baked index. Mach number / Reynolds number are filled in only where a
 * case page states them explicitly; a `null` means the figure was not
 * confirmed from the published page rather than an invented value.
 *
 * REFERENCE DATA: tmr_reference_data proxies the actual experimental/
 * theoretical reference-data file live from the case's own data directory
 * for the handful of cases where that file is unambiguously labeled on the
 * case page (not one of the many turbulence-model CFD-code result files
 * the same directories also hold). Everything is parsed from the TMR's
 * plain-text Tecplot-style `.dat` format: `# comment` lines, a
 * `variables="..."` header naming columns, optional `zone, t="label"`
 * sections, then whitespace-separated numeric rows.
 */


const UA = 'Mozilla/5.0 (compatible; PipeworxResearch/1.0; +https://pipeworx.io; support@pipeworx.io)';
const TMR_BASE = 'https://tmbwg.github.io/turbmodels';
// When the case catalog below (ids, conditions, categories) was transcribed
// from the publisher's live pages — NOT a data_as_of for any single query,
// since the catalog itself is a plain array rather than a live fetch.
const CATALOG_TRANSCRIBED = '2026-10-19';

async function pwFetch(url: string): Promise<Response> {
  return fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 'NASA Langley Turbulence Modeling Resource');
}

// ── Case catalog ────────────────────────────────────────────────────────

interface CaseInfo {
  id: string;
  category: 'verification' | 'validation-basic' | 'validation-extended' | 'validation-high-re' | 'validation-numerics';
  name: string;
  flow_regime: string;
  mach: number | null;
  reynolds: string | null;
  reference_data: boolean;
}

const CASES: CaseInfo[] = [
  { id: 'VERIF/2DZP', category: 'verification', name: '2D Zero Pressure Gradient Flat Plate (verification)', flow_regime: 'incompressible turbulent boundary layer on a flat plate', mach: null, reynolds: '5 million (length-based)', reference_data: false },
  { id: 'VERIF/2DCJ', category: 'verification', name: '2D Coflowing Jet (verification)', flow_regime: 'incompressible planar coflowing (two-stream) shear layer', mach: null, reynolds: '50,000 (based on jet half-width)', reference_data: false },
  { id: 'VERIF/2DB', category: 'verification', name: '2D Bump-in-Channel (verification)', flow_regime: 'subsonic flow over a smooth bump in a 2D channel', mach: null, reynolds: '3 million', reference_data: false },
  { id: 'VERIF/2DANW', category: 'verification', name: '2D Airfoil Near-Wake (verification)', flow_regime: 'low-speed 2D airfoil near-wake', mach: null, reynolds: '1.2 million', reference_data: false },
  { id: 'VERIF/2DMEA', category: 'verification', name: '2D Multielement Airfoil (verification)', flow_regime: 'low-speed high-lift multi-element (flap/slat) airfoil', mach: null, reynolds: '5 million', reference_data: false },
  { id: 'VERIF/3DB', category: 'verification', name: '3D Bump-in-Channel (verification)', flow_regime: 'subsonic flow over a smooth 3D bump in a channel', mach: null, reynolds: '3 million', reference_data: false },
  { id: '2DZP', category: 'validation-basic', name: '2D Zero Pressure Gradient Flat Plate', flow_regime: 'essentially incompressible turbulent boundary layer on a flat plate; Re_theta spans roughly 4,000-13,000 over the plate', mach: 0.2, reynolds: '5 million (length-based)', reference_data: true },
  { id: '2DML', category: 'validation-basic', name: '2D Mixing Layer', flow_regime: 'incompressible two-stream planar turbulent mixing layer (Delville experiment)', mach: null, reynolds: null, reference_data: false },
  { id: '2DANW', category: 'validation-basic', name: '2D Airfoil Near-Wake', flow_regime: 'low-speed 2D airfoil near-wake, same geometry family as the verification case', mach: null, reynolds: null, reference_data: false },
  { id: '2DN00', category: 'validation-basic', name: '2D NACA 0012 Airfoil', flow_regime: 'subsonic 2D NACA 0012 airfoil, lift/drag and surface pressure vs. angle of attack; the TMR documents both an incompressible condition (M=0.15, Ladson data) and a higher-Reynolds condition', mach: 0.15, reynolds: '6 million (incompressible condition, Ladson); a separate 3 million condition is also documented', reference_data: true },
  { id: 'ASJ', category: 'validation-basic', name: 'Axisymmetric Subsonic Jet', flow_regime: 'unheated axisymmetric subsonic free jet', mach: 0.5, reynolds: null, reference_data: false },
  { id: 'AHSJ', category: 'validation-basic', name: 'Axisymmetric Hot Subsonic Jet', flow_regime: 'heated axisymmetric subsonic free jet, same nozzle family as ASJ', mach: 0.5, reynolds: null, reference_data: false },
  { id: 'ANSJ', category: 'validation-basic', name: 'Axisymmetric Near-Sonic Jet', flow_regime: 'axisymmetric free jet near Mach 1', mach: 0.9, reynolds: null, reference_data: false },
  { id: 'ASBL', category: 'validation-basic', name: 'Axisymmetric Separated Boundary Layer', flow_regime: 'low-speed axisymmetric diffuser flow with boundary-layer separation (Driver experiment)', mach: null, reynolds: null, reference_data: false },
  { id: 'ATB', category: 'validation-basic', name: 'Axisymmetric Transonic Bump', flow_regime: 'transonic flow over an axisymmetric bump, shock-induced separation', mach: 0.875, reynolds: null, reference_data: false },
  { id: '2DZPH', category: 'validation-extended', name: '2D Zero Pressure Gradient High Mach Number Flat Plate', flow_regime: 'compressible turbulent boundary layer on a flat plate at supersonic/hypersonic edge Mach numbers (case pages document multiple edge-Mach conditions, including M~2 and M~5)', mach: null, reynolds: '15 million (length-based)', reference_data: false },
  { id: '2DBFS', category: 'validation-extended', name: '2D Backward Facing Step', flow_regime: 'low-speed separated/reattaching flow over a backward-facing step (Driver & Seegmiller experiment)', mach: 0.128, reynolds: '36,000 (based on step height)', reference_data: true },
  { id: '2DN44', category: 'validation-extended', name: '2D NACA 4412 Airfoil Trailing Edge Separation', flow_regime: 'low-speed NACA 4412 airfoil with trailing-edge boundary-layer separation', mach: null, reynolds: null, reference_data: false },
  { id: '2DCC', category: 'validation-extended', name: '2D Convex Curvature Boundary Layer', flow_regime: 'low-speed turbulent boundary layer over convex streamwise curvature (Smits experiment)', mach: null, reynolds: null, reference_data: false },
  { id: '2DWMH', category: 'validation-extended', name: '2D NASA Wall-Mounted Hump Separated Flow', flow_regime: 'low-speed flow over a wall-mounted hump with separation and reattachment ("Case 3" of the CFDVAL2004 workshop)', mach: null, reynolds: '929,000 (chord-based)', reference_data: true },
  { id: 'ACC-SBLI', category: 'validation-extended', name: 'Axisymmetric Compression Corner Interaction near Mach 7', flow_regime: 'hypersonic axisymmetric compression-corner shock/boundary-layer interaction', mach: 7.05, reynolds: null, reference_data: false },
  { id: 'ACSSJ', category: 'validation-extended', name: 'Axisymmetric Cold Supersonic Jet', flow_regime: 'unheated axisymmetric supersonic free jet', mach: 2.0, reynolds: null, reference_data: false },
  { id: 'AHSSJ', category: 'validation-extended', name: 'Axisymmetric Hot Supersonic Jet', flow_regime: 'heated axisymmetric supersonic free jet, same nozzle family as ACSSJ', mach: 2.0, reynolds: null, reference_data: false },
  { id: 'AJM163TM', category: 'validation-extended', name: 'Temperature-Matched Mach 1.63 Axisymmetric Jet', flow_regime: 'axisymmetric supersonic jet, nozzle exit temperature matched to ambient', mach: 1.63, reynolds: null, reference_data: false },
  { id: 'AJM163H', category: 'validation-extended', name: 'Heated Mach 1.63 Axisymmetric Jet', flow_regime: 'axisymmetric supersonic jet, heated nozzle exit, same family as AJM163TM', mach: 1.63, reynolds: null, reference_data: false },
  { id: 'AJM163OD', category: 'validation-extended', name: 'Off-Design Mach 1.63 Axisymmetric Jet', flow_regime: 'axisymmetric supersonic jet operated off its design nozzle pressure ratio (shock-containing plume), same family as AJM163TM', mach: 1.63, reynolds: null, reference_data: false },
  { id: '3DSSD', category: 'validation-extended', name: '3D Supersonic Square Duct', flow_regime: 'fully developed supersonic flow through a square duct, corner secondary flows', mach: 3.9, reynolds: null, reference_data: false },
  { id: 'AISBLI', category: 'validation-extended', name: 'Axisymmetric Impinging-Shock Boundary-Layer Interaction', flow_regime: 'supersonic axisymmetric impinging-shock/boundary-layer interaction', mach: 2.5, reynolds: null, reference_data: false },
  { id: '2DFFP', category: 'validation-numerics', name: '2D Finite Flat Plate', flow_regime: 'the 2DZP flat-plate flow, re-gridded as a finite-length plate for numerical-analysis studies (convergence, order of accuracy)', mach: null, reynolds: '5 million (length-based)', reference_data: false },
  { id: '2DN00W', category: 'validation-numerics', name: '2D NACA 0012 Airfoil (numerics workshop)', flow_regime: 'the 2DN00 NACA 0012 case, re-purposed for numerical-analysis studies', mach: null, reynolds: '6 million', reference_data: false },
  { id: '3DBMOD', category: 'validation-numerics', name: '3D Modified Bump', flow_regime: 'the VERIF/3DB bump-in-channel geometry, halved in spanwise extent for numerical-analysis studies', mach: null, reynolds: '3 million', reference_data: false },
  { id: '3DSSDMOD', category: 'validation-numerics', name: '3D Modified Supersonic Square Duct', flow_regime: 'the 3DSSD supersonic square duct, regridded for numerical-analysis studies', mach: 3.9, reynolds: null, reference_data: false },
  { id: '3DHC', category: 'validation-numerics', name: '3D Hemisphere Cylinder', flow_regime: 'subsonic flow over a 3D hemisphere-cylinder body of revolution', mach: 0.6, reynolds: null, reference_data: false },
  { id: '3DOM6', category: 'validation-numerics', name: '3D ONERA M6 Wing', flow_regime: 'transonic flow over the ONERA M6 wing (Schmitt & Charpin experiment); the classic condition is M~0.84, alpha~3.06 deg', mach: null, reynolds: '11.72 million and 14.6 million conditions are both documented', reference_data: false },
  { id: '2DFDC', category: 'validation-high-re', name: '2D Fully-Developed Channel Flow at High Reynolds Number', flow_regime: 'fully developed 2D channel flow at very high Reynolds number, for checking a model\'s high-Re asymptotic log-law behavior', mach: null, reynolds: 'multiple very high Reynolds numbers are examined, up to roughly 80 million', reference_data: false },
];

const CASE_IDS = CASES.map((c) => c.id);

// ── Reference-data files (curated: only cases with an unambiguous, clearly-labeled reference/experimental file) ──

interface RefFile {
  path: string;
  label: string;
}

const REFERENCE_FILES: Record<string, RefFile> = {
  '2DZP': { path: 'FlatPlate_validation/cf_K-S.dat', label: 'Karman-Schoenherr correlation (Schoenherr 1932): skin-friction coefficient vs. momentum-thickness Reynolds number' },
  '2DN00': { path: 'NACA0012_validation/CLCD_Ladson_expdata.dat', label: 'Ladson (NASA TM 4074, 1988) experimental lift/drag vs. angle of attack, M=0.15, Re=6 million, 80-grit transition strip' },
  '2DBFS': { path: 'Backstep_validation/cf.exp.dat', label: 'Driver & Seegmiller experimental skin-friction coefficient vs. streamwise distance (bottom wall)' },
  '2DWMH': { path: 'Nasahump_validation/noflow_cf.exp.dat', label: 'NASA wall-mounted hump experimental centerspan mean skin-friction coefficient vs. streamwise distance' },
};

// ── Tecplot-style .dat parsing ──────────────────────────────────────────

interface ParsedZone {
  label: string | null;
  rows: number[][];
}

interface ParsedDat {
  comments: string[];
  columns: string[];
  zones: ParsedZone[];
}

function parseTecplotDat(text: string): ParsedDat {
  const comments: string[] = [];
  let columns: string[] = [];
  const zones: ParsedZone[] = [];
  let current: ParsedZone = { label: null, rows: [] };
  let started = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      comments.push(line.replace(/^#+\s*/, ''));
      continue;
    }
    if (/^variables\s*=/i.test(line)) {
      columns = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      continue;
    }
    if (/^zone\b/i.test(line)) {
      if (started) zones.push(current);
      const label = /t\s*=\s*"([^"]*)"/i.exec(line)?.[1] ?? null;
      current = { label, rows: [] };
      started = true;
      continue;
    }
    const nums = line.split(/\s+/).map(Number.parseFloat);
    if (nums.length > 0 && nums.every((n) => Number.isFinite(n))) {
      started = true;
      current.rows.push(nums);
    }
  }
  if (started) zones.push(current);
  return { comments, columns, zones };
}

// ── Tools ───────────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'tmr_cases',
    description:
      "Catalog of NASA Langley Turbulence Modeling Resource (TMR) verification and validation cases for turbulence models — flat plates, bumps-in-channel, airfoils (NACA 0012, NACA 4412), axisymmetric jets, a backward-facing step, the NASA wall-mounted hump, shock/boundary-layer interactions, a supersonic square duct, the ONERA M6 wing, and a high-Reynolds-number channel flow. Each entry gives the case id to pass to tmr_reference_data, its category (verification vs. validation), flow regime, and documented Mach/Reynolds conditions.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', enum: ['verification', 'validation-basic', 'validation-extended', 'validation-high-re', 'validation-numerics'], description: 'Filter to one category. Omit for all cases.' },
      },
    },
  },
  {
    name: 'tmr_reference_data',
    description:
      'Reference data (an experimental measurement or an established correlation, e.g. skin-friction coefficient Cf or lift/drag vs. angle of attack) for one NASA Langley Turbulence Modeling Resource case, as published by the case\'s own data file. Only available for a subset of cases — call tmr_cases first and check "reference_data: true" — because most TMR case directories hold dozens of individual turbulence-model CFD result files alongside the reference data, and this tool only serves files the case page itself unambiguously labels as the reference/experimental data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        case: { type: 'string', enum: CASE_IDS, description: 'Case id from tmr_cases, e.g. "2DZP".' },
      },
      required: ['case'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'tmr_cases': {
      const category = typeof args.category === 'string' ? args.category : undefined;
      const filtered = category ? CASES.filter((c) => c.category === category) : CASES;
      return {
        source: 'NASA Langley Research Center, Turbulence Modeling Resource',
        total: filtered.length,
        cases: filtered,
        // The case list + conditions are transcribed from the publisher's
        // pages at pack-build time, not re-fetched live on every call — so
        // this names when that transcription happened rather than claiming
        // a live data_as_of it would not be making.
        catalog_transcribed: CATALOG_TRANSCRIBED,
      };
    }
    case 'tmr_reference_data': {
      const caseId = String(args.case ?? '');
      const info = CASES.find((c) => c.id === caseId);
      if (!info) {
        return { error: `Unknown case "${caseId}". Call tmr_cases for the list of valid ids.`, valid_cases: CASE_IDS };
      }
      const ref = REFERENCE_FILES[caseId];
      if (!ref) {
        return {
          error: `No reference-data file is mapped for case "${caseId}" yet. Cases with reference data available: ${Object.keys(REFERENCE_FILES).join(', ')}.`,
          case: caseId,
        };
      }
      const res = await pwFetch(`${TMR_BASE}/${ref.path}`);
      if (!res.ok) {
        throw new Error(`NASA Turbulence Modeling Resource returned HTTP ${res.status} for this case's reference data.`);
      }
      const text = await res.text();
      const parsed = parseTecplotDat(text);
      const totalRows = parsed.zones.reduce((sum, z) => sum + z.rows.length, 0);
      if (totalRows === 0) {
        return { error: 'The reference-data file for this case returned no parseable rows.', case: caseId };
      }
      // data_as_of is the upstream file's own Last-Modified date (when the
      // publisher last changed this data) — never a fixed literal written at
      // pack-build time, which would silently go stale the day after it was
      // written. GitHub Pages sends Last-Modified on every static file;
      // fetched_at (this call's own timestamp) is reported regardless, so a
      // caller always knows when WE last asked, even on the rare response
      // that omits the header.
      const lastModifiedHeader = res.headers.get('last-modified');
      const lastModifiedMs = lastModifiedHeader ? Date.parse(lastModifiedHeader) : Number.NaN;
      const dataAsOf = Number.isFinite(lastModifiedMs) ? new Date(lastModifiedMs).toISOString().slice(0, 10) : null;
      return {
        source: 'NASA Langley Research Center, Turbulence Modeling Resource',
        case: caseId,
        case_name: info.name,
        reference: ref.label,
        columns: parsed.columns,
        notes: parsed.comments,
        zones: parsed.zones.map((z) => ({ label: z.label, rows: z.rows })),
        data_as_of: dataAsOf,
        data_as_of_basis: dataAsOf ? 'upstream Last-Modified date of this file' : 'unavailable — upstream response carried no Last-Modified header',
        fetched_at: new Date().toISOString(),
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
