/**
 * clipboardCopyText — yakcc atom source
 *
 * @decision DEC-WEBSITE-DOGFOOD-001
 * Title: Wire clipboardCopyText atom for copy button (Slice 6)
 * Status: accepted
 * Rationale: Per #930 and the dogfood gate, all runtime JS on yakcc.com must
 * originate as a yakcc-shaped atom (pure function, no side-effects on the
 * call-signature, named export). The compiled output of THIS file is what ships
 * in website/public/atoms/. Future iteration (DEC-WEBSITE-DOGFOOD-002) will
 * route this through the full shave→IR→compile chain once TS atoms are
 * supported by the substrate.
 *
 * Atom contract:
 * - Pure function: takes a string, returns Promise<boolean>
 * - No module-level side effects
 * - TS strict-subset shape: explicit param type + return type
 * - Named export only (no default export)
 */
/**
 * Copies the given text to the system clipboard.
 *
 * Returns true on success; false if the Clipboard API is unavailable
 * (non-HTTPS context or restricted permissions) or if the write fails.
 *
 * @param text - The string to copy to the clipboard.
 */
export async function clipboardCopyText(text) {
    if (typeof navigator === "undefined" || !navigator.clipboard || !navigator.clipboard.writeText) {
        return false;
    }
    try {
        await navigator.clipboard.writeText(text);
        return true;
    }
    catch {
        return false;
    }
}
