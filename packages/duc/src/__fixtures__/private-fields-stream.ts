// SPDX-License-Identifier: Apache-2.0
// The Anthropic SDK's lib/MessageStream.js (0.40.1), shrunk to what made its round trip differ
// (#1368): TypeScript's private fields as module `var`s assigned in a computed key, used alike by
// the constructor for more steps than captures were told apart by, more of them than the orders the
// least-identity search tries.
export const PRIVATE_FIELDS_STREAM = `var _MessageStream_connectedPromise, _MessageStream_resolveConnectedPromise, _MessageStream_resolveEndPromise, _MessageStream_rejectEndPromise, _MessageStream_listeners, _MessageStream_ended, _MessageStream_errored, _MessageStream_aborted, _MessageStream_response;
class MessageStream {
    constructor() {
        _MessageStream_resolveConnectedPromise.set(this, () => { });
        _MessageStream_resolveEndPromise.set(this, () => { });
        _MessageStream_rejectEndPromise.set(this, () => { });
        _MessageStream_listeners.set(this, {});
        _MessageStream_ended.set(this, false);
        _MessageStream_errored.set(this, false);
        _MessageStream_aborted.set(this, false);
        _MessageStream_response.set(this, void 0);
        __classPrivateFieldSet(this, _MessageStream_connectedPromise, new Promise((resolve, reject) => {
            __classPrivateFieldSet(this, _MessageStream_resolveConnectedPromise, resolve, "f");
        }), "f");
        __classPrivateFieldSet(this, _MessageStream_endPromise, new Promise((resolve, reject) => {
            __classPrivateFieldSet(this, _MessageStream_rejectEndPromise, reject, "f");
        }));
    }
    [(_MessageStream_connectedPromise = new WeakMap(), _MessageStream_resolveConnectedPromise = new WeakMap(), _MessageStream_resolveEndPromise = new WeakMap(), _MessageStream_rejectEndPromise = new WeakMap(), _MessageStream_listeners = new WeakMap(), _MessageStream_ended = new WeakMap(), _MessageStream_errored = new WeakMap(), _MessageStream_aborted = new WeakMap(), _MessageStream_response = new WeakMap())]() {
    }
}
`;
