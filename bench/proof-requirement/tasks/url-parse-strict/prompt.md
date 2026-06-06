Implement a strict RFC 3986 URL parser. No silent fixup — malformed input throws.

Export a **single class**:

```typescript
export interface ParsedUrl {
  scheme: string;           // lowercase, no colon
  userinfo: string | null;  // user:password or null
  host: string | null;      // decoded hostname or null (authority-less URLs)
  port: number | null;      // parsed integer or null
  path: string;             // may be empty; always present
  query: string | null;     // without leading "?"
  fragment: string | null;  // without leading "#"
}

export class UrlParser {
  /** Parse a URL string into its RFC 3986 components.
   *  Throws RangeError on malformed input. */
  static parse(input: string): ParsedUrl;
}
```

Constraints:
- No `URL` constructor, no `URL` class, no WHATWG parsing.
- `scheme` must match `[a-zA-Z][a-zA-Z0-9+\-.]*` — throw on violation.
- Port must be 1–65535 — throw if out of range.
- Percent-encoding is left in-place (do not decode host/path/query in the output).
- An empty authority (`//`) is valid: `host = ""`, `userinfo = null`, `port = null`.
- Fragment is optional; `#` without text produces `fragment = ""`.
- Query is optional; `?` without text produces `query = ""`.

Test cases:
- `"https://user:pw@example.com:443/path?q=1#frag"` →
  `{ scheme:"https", userinfo:"user:pw", host:"example.com", port:443, path:"/path", query:"q=1", fragment:"frag" }`
- `"ftp://ftp.is.co.za/rfc/rfc1808.txt"` →
  `{ scheme:"ftp", userinfo:null, host:"ftp.is.co.za", port:null, path:"/rfc/rfc1808.txt", query:null, fragment:null }`
- `"urn:example:animal:ferret:nose"` →
  `{ scheme:"urn", userinfo:null, host:null, port:null, path:"example:animal:ferret:nose", query:null, fragment:null }`
- `"not a url"` → throws `RangeError`
