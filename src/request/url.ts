// ---------------------------------------------------------------------------
// Request URL transformation
// ---------------------------------------------------------------------------

export function transformRequestUrl(input: unknown): {
    requestInput: unknown;
    requestUrl: URL | null;
} {
    let requestInput = input;
    let requestUrl: URL | null = null;
    try {
        if (typeof input === "string" || input instanceof URL) {
            requestUrl = new URL(input.toString());
        } else if (input instanceof Request) {
            requestUrl = new URL(input.url);
        }
    } catch {
        requestUrl = null;
    }

    if (
        requestUrl &&
        (requestUrl.pathname === "/v1/messages" || requestUrl.pathname === "/v1/messages/count_tokens") &&
        !requestUrl.searchParams.has("beta")
    ) {
        requestUrl.searchParams.set("beta", "true");
        requestInput = input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl;
    }

    return { requestInput, requestUrl };
}
