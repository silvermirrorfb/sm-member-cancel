import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PR-C: the chat model must come from ANTHROPIC_MODEL (default to a current
// supported model), never a hardcoded dated snapshot id that Anthropic later
// retires with a 404 (which surfaced as prod 500s on /api/chat/message).

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor() {
      this.messages = { create: (...args) => mockCreate(...args) };
    }
  },
}));

import { getAnthropicModel, sendMessage, verifyAnthropicModel } from '../src/lib/claude.js';

const originalEnv = process.env;

describe('anthropic model config', () => {
  beforeEach(() => {
    process.env = { ...originalEnv, ANTHROPIC_API_KEY: 'sk-test' };
    delete process.env.ANTHROPIC_MODEL;
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  });
  afterEach(() => { process.env = originalEnv; });

  it('defaults to a current supported model when ANTHROPIC_MODEL is unset', () => {
    expect(getAnthropicModel()).toBe('claude-sonnet-4-6');
  });

  it('reads ANTHROPIC_MODEL from the environment when set', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-8';
    expect(getAnthropicModel()).toBe('claude-opus-4-8');
  });

  it('sendMessage calls the API with the configured model, not a hardcoded dated id', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    await sendMessage('system', [{ role: 'user', content: 'hi' }]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
    expect(mockCreate.mock.calls[0][0].model).not.toMatch(/-\d{8}$/); // no dated snapshot id
  });

  it('verifyAnthropicModel returns ok when the model resolves', async () => {
    const result = await verifyAnthropicModel();
    expect(result.ok).toBe(true);
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('verifyAnthropicModel surfaces a bad model as an error instead of throwing', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
    mockCreate.mockRejectedValue(new Error('404 model: claude-sonnet-4-20250514 not found'));
    const result = await verifyAnthropicModel();
    expect(result.ok).toBe(false);
    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.error).toContain('not found');
  });
});
