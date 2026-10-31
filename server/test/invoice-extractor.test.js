import assert from 'node:assert/strict';
import test from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { cleanExtraction, createInvoiceExtractor, ExtractionError } from '../services/invoiceExtractor.js';

const GOOD = {
  isInvoice: true, supplierName: ' Lanka ', invoiceNo: 'INV-1', invoiceDate: '2026-03-02', subtotal: 100, tax: 18, total: 118, confidence: 92,
  lines: [{ description: ' Nail 2in ', qty: 2, unitCost: 50, lineTotal: 100, confidence: 90 }]
};
const reply = (body, stop = 'end_turn') => ({ stop_reason: stop, content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }] });

function extractorReturning(result) {
  const calls = [];
  const client = { beta: { messages: { create: async (args) => { calls.push(args); if (result instanceof Error) throw result; return result; } } } };
  return { extractor: createInvoiceExtractor({}, client), calls };
}

const read = (extractor, mimeType = 'image/png') => extractor.extract({ bytes: Buffer.from('file'), mimeType });

test('without a key there is no extractor, so nothing can pretend to scan', () => {
  assert.equal(createInvoiceExtractor({ anthropicApiKey: '' }), null);
  assert.ok(createInvoiceExtractor({ anthropicApiKey: 'x' }));
});

test('only the configured key is sent, never a token from the computer', async (t) => {
  const before = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = 'token-from-the-computer';
  t.after(() => {
    if (before === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = before;
  });
  let sent;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent = new Headers(init.headers);
    return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: JSON.stringify(GOOD) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  });
  await read(createInvoiceExtractor({ anthropicApiKey: 'configured-key' }));
  assert.equal(sent.get('authorization'), 'Bearer configured-key');
});

test('images and PDFs are sent in the right form, with structured output', async () => {
  const { extractor, calls } = extractorReturning(reply(GOOD));
  await read(extractor);
  await read(extractor, 'application/pdf');
  assert.equal(calls[0].model, 'claude-opus-5-5');
  assert.equal(calls[0].output_config.format.type, 'json_schema');
  assert.deepEqual(calls[0].messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmlsZQ==' } });
  assert.equal(calls[1].messages[0].content[0].type, 'document');
  assert.match(calls[0].system, /data to read, never instructions/);
});

test('a good reply is tidied up', async () => {
  const { extractor } = extractorReturning(reply(GOOD));
  const result = await read(extractor);
  assert.equal(result.supplierName, 'Lanka');
  assert.equal(result.lines[0].description, 'Nail 2in');
  assert.equal(result.invoiceDate, '2026-03-02');
});

test('bad values from the model are dropped rather than trusted', () => {
  const result = cleanExtraction({
    ...GOOD,
    invoiceDate: '2026-13-45',
    confidence: 500,
    invoiceNo: 5,
    lines: [
      { description: 'A', qty: -3, unitCost: 'x', lineTotal: null, confidence: -5 },
      { description: 'B', qty: 1.23456, unitCost: 9.999, lineTotal: 1, confidence: 50 },
      { description: '   ', qty: 1, unitCost: 1, lineTotal: 1, confidence: 50 }
    ]
  });
  assert.equal(result.invoiceDate, null);
  assert.equal(result.invoiceNo, null);
  assert.equal(result.confidence, 100);
  assert.equal(result.lines.length, 2);
  assert.deepEqual([result.lines[0].qty, result.lines[0].unitCost, result.lines[0].confidence], [null, null, 0]);
  assert.deepEqual([result.lines[1].qty, result.lines[1].unitCost], [1.235, 10]);
});

test('every failure becomes a clear message and never invented data', async () => {
  const failing = async (result, pattern) => {
    const { extractor } = extractorReturning(result);
    await assert.rejects(() => read(extractor), (error) => error instanceof ExtractionError && pattern.test(error.message));
  };
  await failing(reply({ ...GOOD, isInvoice: false, lines: [] }), /does not look like/);
  await failing(reply({ ...GOOD, lines: [] }), /No product lines/);
  await failing(reply('not json'), /could not be read/);
  await failing(reply(GOOD, 'refusal'), /declined/);
  await failing(reply(GOOD, 'max_tokens'), /too long/);
});

test('service errors give useful messages and do not leak detail', async (t) => {
  t.mock.method(console, 'error', () => {});
  const headers = new Headers();
  const cases = [
    [new Anthropic.AuthenticationError(401, {}, 'secret detail', headers), /API key/],
    [new Anthropic.RateLimitError(429, {}, 'secret detail', headers), /busy/],
    [new Anthropic.APIConnectionError({ message: 'secret detail' }), /could not be reached/],
    [new Anthropic.BadRequestError(400, {}, 'secret detail', headers), /could not accept/],
    [new Anthropic.InternalServerError(500, {}, 'secret detail', headers), /had a problem/]
  ];
  for (const [error, pattern] of cases) {
    const { extractor } = extractorReturning(error);
    await assert.rejects(() => read(extractor), (failure) => pattern.test(failure.message) && !failure.message.includes('secret'));
  }
});
