"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageRetryManager = exports.RetryReason = void 0;

const lru_cache_1 = require("lru-cache");

const RECENT_MESSAGES_SIZE = 1000;
const MESSAGE_KEY_SEPARATOR = '\u0000';
const RECREATE_SESSION_TIMEOUT = 60 * 60 * 1000;

var RetryReason;
(function (RetryReason) {
    RetryReason[RetryReason["UnknownError"] = 0] = "UnknownError";
    RetryReason[RetryReason["SignalErrorNoSession"] = 1] = "SignalErrorNoSession";
    RetryReason[RetryReason["SignalErrorInvalidKey"] = 2] = "SignalErrorInvalidKey";
    RetryReason[RetryReason["SignalErrorInvalidKeyId"] = 3] = "SignalErrorInvalidKeyId";
    RetryReason[RetryReason["SignalErrorInvalidMessage"] = 4] = "SignalErrorInvalidMessage";
    RetryReason[RetryReason["SignalErrorInvalidSignature"] = 5] = "SignalErrorInvalidSignature";
    RetryReason[RetryReason["SignalErrorFutureMessage"] = 6] = "SignalErrorFutureMessage";
    RetryReason[RetryReason["SignalErrorBadMac"] = 7] = "SignalErrorBadMac";
    RetryReason[RetryReason["SignalErrorInvalidSession"] = 8] = "SignalErrorInvalidSession";
    RetryReason[RetryReason["SignalErrorInvalidMsgKey"] = 9] = "SignalErrorInvalidMsgKey";
    RetryReason[RetryReason["BadBroadcastEphemeralSetting"] = 10] = "BadBroadcastEphemeralSetting";
    RetryReason[RetryReason["UnknownCompanionNoPrekey"] = 11] = "UnknownCompanionNoPrekey";
    RetryReason[RetryReason["AdvFailure"] = 12] = "AdvFailure";
    RetryReason[RetryReason["StatusRevokeDelay"] = 13] = "StatusRevokeDelay";
})(RetryReason = exports.RetryReason || (exports.RetryReason = {}));

const MAC_ERROR_CODES = new Set([RetryReason.SignalErrorInvalidMessage, RetryReason.SignalErrorBadMac]);

class MessageRetryManager {
    constructor(logger, maxMsgRetryCount = 5) {
        this.logger = logger;
        this.maxMsgRetryCount = maxMsgRetryCount;
        this.messageKeyIndex = new Map();
        this.pendingPhoneRequests = {};
        this.statistics = {
            totalRetries: 0,
            successfulRetries: 0,
            failedRetries: 0,
            mediaRetries: 0,
            sessionRecreations: 0,
            phoneRequests: 0
        };
        this.recentMessagesMap = new lru_cache_1.LRUCache({
            max: RECENT_MESSAGES_SIZE,
            ttl: 5 * 60 * 1000,
            ttlAutopurge: true,
            dispose: (_value, key) => {
                const separatorIndex = key.lastIndexOf(MESSAGE_KEY_SEPARATOR);
                if (separatorIndex > -1) {
                    const messageId = key.slice(separatorIndex + MESSAGE_KEY_SEPARATOR.length);
                    this.messageKeyIndex.delete(messageId);
                }
            }
        });
        this.sessionRecreateHistory = new lru_cache_1.LRUCache({
            max: 10000,
            ttl: RECREATE_SESSION_TIMEOUT,
            ttlAutopurge: true
        });
        this.retryCounters = new lru_cache_1.LRUCache({
            max: 5000,
            ttl: 15 * 60 * 1000,
            ttlAutopurge: true
        });
        this.baseKeys = new lru_cache_1.LRUCache({
            max: 1024,
            ttl: 15 * 60 * 1000,
            ttlAutopurge: true
        });
    }

    addRecentMessage(key, message) {
        const id = key.id;
        if (!id) return;
        const keyStr = this.keyToString(key);
        this.recentMessagesMap.set(keyStr, { message, timestamp: Date.now() });
        this.messageKeyIndex.set(id, keyStr);
    }

    getRecentMessage(key) {
        const keyStr = this.keyToString(key);
        return this.recentMessagesMap.get(keyStr);
    }

    shouldRecreateSession(jid, hasSession, errorCode) {
        if (!hasSession) {
            this.sessionRecreateHistory.set(jid, Date.now());
            this.statistics.sessionRecreations++;
            return { reason: 'no existing session', recreate: true };
        }
        if (errorCode !== undefined && MAC_ERROR_CODES.has(errorCode)) {
            this.sessionRecreateHistory.set(jid, Date.now());
            this.statistics.sessionRecreations++;
            this.logger.warn({ jid, errorCode: RetryReason[errorCode] }, 'MAC error detected, forcing immediate session recreation');
            return {
                reason: `MAC error (code ${errorCode}: ${RetryReason[errorCode]}), immediate session recreation`,
                recreate: true
            };
        }
        const now = Date.now();
        const prevTime = this.sessionRecreateHistory.get(jid);
        if (!prevTime || now - prevTime > RECREATE_SESSION_TIMEOUT) {
            this.sessionRecreateHistory.set(jid, now);
            this.statistics.sessionRecreations++;
            return { reason: 'session recreation timeout window expired', recreate: true };
        }
        return {
            reason: `session recreated recently at ${new Date(prevTime).toISOString()}, skipping`,
            recreate: false
        };
    }

    parseRetryErrorCode(errorAttr) {
        if (errorAttr === undefined || errorAttr === '') return undefined;
        const code = parseInt(errorAttr, 10);
        if (Number.isNaN(code)) return undefined;
        if (code >= RetryReason.UnknownError && code <= RetryReason.StatusRevokeDelay) return code;
        return RetryReason.UnknownError;
    }

    isMacError(errorCode) {
        return errorCode !== undefined && MAC_ERROR_CODES.has(errorCode);
    }

    incrementRetryCount(messageId) {
        this.retryCounters.set(messageId, (this.retryCounters.get(messageId) || 0) + 1);
        this.statistics.totalRetries++;
        return this.retryCounters.get(messageId);
    }

    getRetryCount(messageId) {
        return this.retryCounters.get(messageId) || 0;
    }

    hasExceededMaxRetries(messageId) {
        return this.getRetryCount(messageId) >= this.maxMsgRetryCount;
    }

    markRetrySuccess(messageId) {
        this.statistics.successfulRetries++;
        this.retryCounters.delete(messageId);
        this.cancelPendingPhoneRequest(messageId);
        this.removeRecentMessage(messageId);
    }

    markRetryFailed(messageId) {
        this.statistics.failedRetries++;
        this.retryCounters.delete(messageId);
        this.cancelPendingPhoneRequest(messageId);
        this.removeRecentMessage(messageId);
    }

    schedulePhoneRequest(messageId, callback, delayMs = 3000) {
        this.cancelPendingPhoneRequest(messageId);
        this.pendingPhoneRequests[messageId] = setTimeout(() => {
            delete this.pendingPhoneRequests[messageId];
            this.statistics.phoneRequests++;
            callback();
        }, delayMs);
    }

    cancelPendingPhoneRequest(messageId) {
        const timeout = this.pendingPhoneRequests[messageId];
        if (timeout) {
            clearTimeout(timeout);
            delete this.pendingPhoneRequests[messageId];
            this.logger.debug(`Cancelled pending phone request for message ${messageId}`);
        }
    }

    keyToString(key) {
        return `${key.to}${MESSAGE_KEY_SEPARATOR}${key.id}`;
    }

    removeRecentMessage(messageId) {
        const keyStr = this.messageKeyIndex.get(messageId);
        if (!keyStr) return;
        this.recentMessagesMap.delete(keyStr);
        this.messageKeyIndex.delete(messageId);
    }
}

exports.MessageRetryManager = MessageRetryManager;
