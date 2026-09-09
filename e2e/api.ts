/**
 * The API, called directly from a spec — to read what a screen should be
 * showing, or to write the fixture a screen is then driven against.
 *
 * Four specs each carried their own copy of this, and each copy had the same
 * hole: after the last refusal it returned the *error* body as though it were
 * data. The test then read `undefined` off it and failed a minute later on a
 * locator that was never going to appear, naming a screen that was working. A
 * refusal is reported here, where it happened, with the status and the body.
 *
 * Retries exist because the platform's per-principal limiter is 600 requests a
 * real minute, and a whole suite in one worker runs close to it. A refused read
 * is not a failing product, it is a failing question — it used to surface as
 * `undefined.find` and "expected 5, received 0" on whichever test was unlucky.
 * Asking again after a moment is what the retry-after header is for. Only
 * a rate limit is worth repeating on a write: a POST that failed for any other
 * reason may well have written something, and asking again would write it
 * twice.
 */
import type { APIRequestContext, APIResponse } from '@playwright/test';

const ATTEMPTS = 4;
const backoff = (attempt: number) => new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));

export const getJson = async <T = unknown>(request: APIRequestContext, url: string): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await request.get(url);
    if (response.ok()) return (await response.json()) as T;
    if (attempt >= ATTEMPTS - 1) throw new Error(`GET ${url} → ${response.status()}: ${await response.text()}`);
    await backoff(attempt);
  }
};

export const postJson = async <T = unknown>(request: APIRequestContext, url: string, data: unknown): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await request.post(url, { data });
    if (response.ok()) return (await response.json()) as T;
    if (attempt >= ATTEMPTS - 1 || response.status() !== 429) {
      throw new Error(`POST ${url} → ${response.status()}: ${await response.text()}`);
    }
    await backoff(attempt);
  }
};

/**
 * A request whose *status* is the assertion, sent past the limiter.
 *
 * Some fixture steps are checked by their status rather than their body — a
 * seat accepted, a seat deleted. A 429 there fails the assertion and reads
 * like the product refusing a legitimate call, so the refusal is waited out
 * and anything else is handed back untouched for the test to judge.
 */
export const past429 = async (send: () => Promise<APIResponse>): Promise<APIResponse> => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await send();
    if (response.status() !== 429 || attempt >= ATTEMPTS - 1) return response;
    await backoff(attempt);
  }
};
