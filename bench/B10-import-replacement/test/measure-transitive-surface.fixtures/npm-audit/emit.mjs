// T11 fixture: vuln-pkg (1.2.3) has a planted CVE; safe-pkg (2.0.0) does not
// Expected: npm_audit.cve_pattern_matches = 1 (for vuln-pkg), audit_source: "offline-db"
import { vulnFn } from "vuln-pkg";
import { safeFn } from "safe-pkg";
export function emitFn() { return vulnFn() + safeFn(); }
