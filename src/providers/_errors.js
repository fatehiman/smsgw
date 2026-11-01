'use strict';

class ProviderError extends Error {
  constructor(message, { code = 'provider_error', retryable = false } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

module.exports = { ProviderError };
