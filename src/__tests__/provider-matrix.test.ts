/**
 * Provider compatibility tests — verifies provider-agnostic behavior
 * WITHOUT making real API calls.
 *
 * Covers: temperature handling, capability flags, provider detection,
 * and image block normalization.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROVIDERS, detectProvider } from '../llm/providers';
import { normalizeImageBlock } from '../llm/client';
import type { PipelineConfig } from '../llm/providers';
import type { VisionContentBlock } from '../llm/client';

// ── Mock fetch globally so no real HTTP calls are made ──────────────────────

const fetchMock = vi.fn();
(globalThis as any).fetch = fetchMock;

function makeOpenAIResponse(content = 'ok') {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

function makeAnthropicResponse(text = 'ok') {
  return {
    ok: true,
    json: async () => ({ content: [{ text }] }),
  };
}

function makeConfig(providerKey: string, overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  const provider = PROVIDERS[providerKey];
  return {
    provider,
    providerKey,
    apiKey: 'test-key',
    layer1: true,
    layer2: {
      enabled: true,
      model: provider.textModel || 'test-text-model',
      baseUrl: provider.baseUrl || 'http://localhost:11434/v1',
    },
    layer3: {
      enabled: true,
      model: provider.visionModel || 'test-vision-model',
      baseUrl: provider.baseUrl || 'http://localhost:11434/v1',
      computerUse: provider.computerUse,
    },
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Temperature handling per provider
// ═════════════════════════════════════════════════════════════════════════════

describe('Temperature handling per provider', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('kimi vision calls with kimi-k2.5 model should NOT include temperature', async () => {
    fetchMock.mockResolvedValueOnce(makeOpenAIResponse());

    const { callVisionLLM } = await import('../llm/client');
    const config = makeConfig('kimi');
    // kimi's visionModel is 'kimi-k2.5' which starts with 'kimi-k2'
    await callVisionLLM(config, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'describe this' }] }],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.temperature).toBeUndefined();
  });

  it('kimi text calls with non-reasoning model should include temperature: 0', async () => {
    fetchMock.mockResolvedValueOnce(makeOpenAIResponse());

    const { callTextLLM } = await import('../llm/client');
    const config = makeConfig('kimi');
    // kimi's textModel is 'moonshot-v1-8k' which does NOT start with 'kimi-k2'
    await callTextLLM(config, { user: 'hello' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.temperature).toBe(0);
  });

  it('OpenAI text calls always include temperature: 0', async () => {
    fetchMock.mockResolvedValueOnce(makeOpenAIResponse());

    const { callTextLLM } = await import('../llm/client');
    const config = makeConfig('openai');
    await callTextLLM(config, { user: 'hello' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.temperature).toBe(0);
  });

  it('OpenAI vision calls include temperature: 0', async () => {
    fetchMock.mockResolvedValueOnce(makeOpenAIResponse());

    const { callVisionLLM } = await import('../llm/client');
    const config = makeConfig('openai');
    await callVisionLLM(config, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }] }],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.temperature).toBe(0);
  });

  it('Anthropic text calls include temperature: 0', async () => {
    fetchMock.mockResolvedValueOnce(makeAnthropicResponse());

    const { callTextLLM } = await import('../llm/client');
    const config = makeConfig('anthropic');
    await callTextLLM(config, { user: 'hello' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.temperature).toBe(0);
  });

  it('Anthropic vision calls include temperature: 0', async () => {
    fetchMock.mockResolvedValueOnce(makeAnthropicResponse());

    const { callVisionLLM } = await import('../llm/client');
    const config = makeConfig('anthropic');
    await callVisionLLM(config, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }] }],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.temperature).toBe(0);
  });

  it('Groq text and vision calls include temperature: 0', async () => {
    fetchMock.mockResolvedValueOnce(makeOpenAIResponse());

    const { callTextLLM } = await import('../llm/client');
    const config = makeConfig('groq');
    await callTextLLM(config, { user: 'hello' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.temperature).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Provider capability flags
// ═════════════════════════════════════════════════════════════════════════════

describe('Provider capability flags', () => {
  const requiredFields: (keyof typeof PROVIDERS[string])[] = [
    'name', 'baseUrl', 'authHeader', 'textModel', 'visionModel', 'openaiCompat', 'computerUse',
  ];

  it('all providers have required fields', () => {
    for (const [key, profile] of Object.entries(PROVIDERS)) {
      for (const field of requiredFields) {
        expect(profile, `Provider "${key}" missing field "${field}"`).toHaveProperty(field);
      }
    }
  });

  it('only Anthropic has computerUse: true', () => {
    for (const [key, profile] of Object.entries(PROVIDERS)) {
      if (key === 'anthropic') {
        expect(profile.computerUse, `Anthropic should have computerUse: true`).toBe(true);
      } else {
        expect(profile.computerUse, `Provider "${key}" should have computerUse: false`).toBe(false);
      }
    }
  });

  it('Anthropic has openaiCompat: false, all others have openaiCompat: true', () => {
    for (const [key, profile] of Object.entries(PROVIDERS)) {
      if (key === 'anthropic') {
        expect(profile.openaiCompat, `Anthropic should have openaiCompat: false`).toBe(false);
      } else {
        expect(profile.openaiCompat, `Provider "${key}" should have openaiCompat: true`).toBe(true);
      }
    }
  });

  it('kimi uses a reasoning vision model (kimi-k2.5)', () => {
    // The kimi provider's visionModel starts with 'kimi-k2', which triggers
    // the reasoning model path (temperature omitted) in llm-client
    expect(PROVIDERS.kimi.visionModel).toMatch(/^kimi-k2/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Provider detection
// ═════════════════════════════════════════════════════════════════════════════

describe('Provider detection', () => {
  it('sk-ant-... keys detect as anthropic', () => {
    expect(detectProvider('sk-ant-abc123def456')).toBe('anthropic');
  });

  it('short sk- keys detect as openai', () => {
    expect(detectProvider('sk-short')).toBe('openai');
  });

  it('long sk- keys (60+ chars) detect as kimi', () => {
    const longKey = 'sk-' + 'a'.repeat(60);
    expect(detectProvider(longKey)).toBe('kimi');
  });

  it('gsk_... keys detect as groq', () => {
    expect(detectProvider('gsk_abc123def456')).toBe('groq');
  });

  it('AIza... keys detect as gemini', () => {
    expect(detectProvider('AIzaSyAbcdefghijklmnopqrstuvwxyz')).toBe('gemini');
  });

  it('xai-... keys detect as xai', () => {
    expect(detectProvider('xai-abc123def456')).toBe('xai');
  });

  it('empty key detects as ollama', () => {
    expect(detectProvider('')).toBe('ollama');
  });

  it('unknown key format falls back to openai', () => {
    expect(detectProvider('random-unknown-key-format')).toBe('openai');
  });

  it('explicit provider overrides key-based detection', () => {
    expect(detectProvider('sk-ant-abc123', 'groq')).toBe('groq');
  });

  it('unknown explicit provider falls back to generic', () => {
    expect(detectProvider('some-key', 'nonexistent-provider')).toBe('generic');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Image normalization
// ═════════════════════════════════════════════════════════════════════════════

describe('Image normalization', () => {
  const openaiImageBlock: VisionContentBlock = {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANS' },
  };

  const anthropicImageBlock: VisionContentBlock = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANS' },
  };

  const textBlock: VisionContentBlock = {
    type: 'text',
    text: 'Describe this image',
  };

  it('converts OpenAI format to Anthropic format', () => {
    const result = normalizeImageBlock(openaiImageBlock, true);
    expect(result.type).toBe('image');
    expect(result.source).toBeDefined();
    expect(result.source.type).toBe('base64');
    expect(result.source.media_type).toBe('image/png');
    expect(result.source.data).toBe('iVBORw0KGgoAAAANS');
  });

  it('converts Anthropic format to OpenAI format', () => {
    const result = normalizeImageBlock(anthropicImageBlock, false);
    expect(result.type).toBe('image_url');
    expect(result.image_url).toBeDefined();
    expect(result.image_url.url).toBe('data:image/png;base64,iVBORw0KGgoAAAANS');
  });

  it('passes through Anthropic format when target is Anthropic', () => {
    const result = normalizeImageBlock(anthropicImageBlock, true);
    expect(result).toEqual(anthropicImageBlock);
  });

  it('passes through OpenAI format when target is OpenAI', () => {
    const result = normalizeImageBlock(openaiImageBlock, false);
    expect(result).toEqual(openaiImageBlock);
  });

  it('text blocks pass through unchanged (Anthropic target)', () => {
    const result = normalizeImageBlock(textBlock, true);
    expect(result).toEqual(textBlock);
  });

  it('text blocks pass through unchanged (OpenAI target)', () => {
    const result = normalizeImageBlock(textBlock, false);
    expect(result).toEqual(textBlock);
  });
});
