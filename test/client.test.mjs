/**
 * Unit tests for the client half's pure logic.
 *
 * `client.js` is a browser module: it registers itself with
 * `window.__ModuleLoader__` and touches `document` only from inside `apply()`
 * and the fill driver. A minimal window shim is therefore enough to load it in
 * Node and exercise the catalog logic through the `__pure` seam.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

let captured;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
    },
  },
};

await import('../client.js');
assert.equal(captured.id, 'dsh-auto-meta', 'client registers itself under the package id');

const api = captured.factory(() => ({}));
const pure = api.__pure;

assert.equal(typeof api.apply, 'function');
assert.equal(typeof pure.resolveMeta, 'function');

const EFFORT_OPTIONS = [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }];

/** A tiny models.dev-shaped document, fed through `compact()` like the real one. */
function catalog(providers) {
  return pure.buildIndex(pure.compact(providers));
}

test('toEfforts maps effort values and keeps "off" as null', () => {
  assert.deepEqual(pure.toEfforts(EFFORT_OPTIONS), { off: null, low: 'low', high: 'high', max: 'max' });
});

test('toEfforts refuses a bare toggle, which names no wire value', () => {
  assert.equal(pure.toEfforts([{ type: 'toggle' }]), undefined);
  assert.equal(pure.toEfforts([]), undefined);
  assert.equal(pure.toEfforts(undefined), undefined);
});

test('toEfforts refuses a map that offers nothing beyond "off"', () => {
  assert.equal(pure.toEfforts([{ type: 'effort', values: ['none'] }]), undefined);
});

test('planReasoning orders levels ascending and keeps null wire for off', () => {
  assert.deepEqual(pure.planReasoning({ off: null, high: 'high', low: 'low' }), [
    { level: 'off', wire: null },
    { level: 'low', wire: 'low' },
    { level: 'high', wire: 'high' },
  ]);
  assert.equal(pure.planReasoning(undefined), undefined);
});

test('norm folds punctuation, case, and provider separators', () => {
  assert.equal(pure.norm('DeepSeek-V4.1 Flash'), pure.norm('deepseek_v4_1flash'));
  assert.equal(pure.norm(undefined), '');
});

test('route tier wins when the configured provider carries the model', () => {
  const index = catalog({
    'my-gateway': {
      name: 'My Gateway',
      models: {
        'glm-5': {
          name: 'GLM-5',
          limit: { context: 200000, output: 64000 },
          modalities: { input: ['text', 'image'] },
          reasoning_options: EFFORT_OPTIONS,
          canonical_model_id: 'zai/glm-5',
        },
      },
    },
    zai: {
      name: 'Z.ai',
      models: {
        'glm-5': { name: 'GLM-5', limit: { context: 128000, output: 8192 } },
      },
    },
  });
  const meta = pure.resolveMeta(index, 'glm-5', 'my-gateway');
  assert.equal(meta.tier, 'route');
  assert.equal(meta.source, 'my-gateway');
  assert.equal(meta.fields.contextWindow, 200000);
  assert.equal(meta.fields.maxTokens, 64000);
  assert.deepEqual(meta.fields.input, ['text', 'image']);
  assert.deepEqual(meta.fields.reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max' });
});

test('vendor tier follows the canonical id when the route has no own record', () => {
  const index = catalog({
    openrouter: {
      name: 'OpenRouter',
      models: {
        'zai/glm-5': {
          name: 'GLM-5',
          limit: { context: 200000, output: 64000 },
          canonical_model_id: 'zai/glm-5',
        },
      },
    },
    zai: {
      name: 'Z.ai',
      models: { 'glm-5': { name: 'GLM-5', limit: { context: 128000, output: 8192 } } },
    },
  });
  const meta = pure.resolveMeta(index, 'zai/glm-5', 'unrelated-route');
  assert.equal(meta.tier, 'vendor');
  assert.equal(meta.source, 'zai');
  assert.equal(meta.fields.contextWindow, 128000);
  assert.equal(meta.fields.maxTokens, 8192);
});

test('consensus tier takes only majority fields across carriers', () => {
  const index = catalog({
    a: { name: 'A', models: { 'x-model': { limit: { context: 1000, output: 100 }, modalities: { input: ['text'] } } } },
    b: { name: 'B', models: { 'x-model': { limit: { context: 1000, output: 100 }, modalities: { input: ['text', 'image'] } } } },
    c: { name: 'C', models: { 'x-model': { limit: { context: 999, output: 100 }, modalities: { input: ['text'] } } } },
  });
  const meta = pure.resolveMeta(index, 'x-model', 'nowhere');
  assert.equal(meta.tier, 'consensus');
  assert.equal(meta.fields.contextWindow, 1000, '2 of 3 agree');
  assert.equal(meta.fields.maxTokens, 100, '3 of 3 agree');
  assert.deepEqual(meta.fields.input, ['text'], 'only 1 of 3 declares image, so text only');
});

test('an unknown id resolves to nothing instead of guessing', () => {
  const index = catalog({ a: { name: 'A', models: { known: { limit: { context: 1, output: 1 } } } } });
  assert.equal(pure.resolveMeta(index, 'unknown', 'a').tier, 'none');
  assert.deepEqual(pure.resolveMeta(index, 'unknown', 'a').fields, {});
});

test('modalOf-free compact keeps only the fields the page needs', () => {
  const index = catalog({
    a: { name: 'A', models: { m: { limit: { context: 10, output: 5 }, modalities: { input: ['text'] }, canonical_model_id: 'a/m' } } },
  });
  const record = index.byModel.get('am')[0];
  assert.deepEqual(Object.keys(record).sort(), ['c', 'canonical', 'i', 'key', 'name', 'o', 'providerId', 'r']);
});

test('needsFit flags a grid whose children outgrow its tracks', () => {
  // The shell row is four tracks: model id, model name, chevron, delete.
  assert.equal(pure.needsFit('grid', 4, 4, undefined), false, 'untouched four-track row needs nothing');
  assert.equal(pure.needsFit('grid', 4, 5, undefined), true, 'our button is the fifth child and would wrap');
  assert.equal(pure.needsFit('grid', 5, 5, undefined), false, 'a build with a spare track already fits');
});

test('needsFit respects a wrapping flex row and ignores other layouts', () => {
  assert.equal(pure.needsFit('flex', 0, 5, 'wrap'), true);
  assert.equal(pure.needsFit('flex', 0, 5, 'nowrap'), false, 'already single-line, do not touch it');
  assert.equal(pure.needsFit('block', 0, 5, undefined), false, 'unknown layout: leave it alone');
  assert.equal(pure.needsFit('grid', 0, 5, undefined), false, 'no tracks resolved yet: wait for the next scan');
});

/* ───────────────────── OpenRouter (primary) catalog ───────────────────── */

/** Three real `deepseek-v4.1-flash` entries, captured from the live endpoint. */
const OPENROUTER_FIXTURE = JSON.parse(
  fs.readFileSync(new URL('./fixtures/openrouter-deepseek-v4.1-flash.json', import.meta.url), 'utf8'),
);

test('effortMap turns OpenRouter "none" into the off level', () => {
  assert.deepEqual(pure.effortMap(['max', 'high', 'low', 'none']), { off: null, low: 'low', high: 'high', max: 'max' });
  assert.deepEqual(pure.effortMap(['medium']), { medium: 'medium' });
  assert.equal(pure.effortMap(['none']), undefined, 'a toggle with no real level fills nothing');
  assert.equal(pure.effortMap(undefined), undefined);
});

test('baseId drops the provider prefix, variant suffix and snapshot date', () => {
  assert.equal(pure.baseId('deepseek/deepseek-v4.1-flash'), 'deepseekv41flash');
  assert.equal(pure.baseId('deepseek/deepseek-v4.1-flash:batch'), pure.baseId('deepseek/deepseek-v4.1-flash'));
  assert.equal(pure.baseId('deepseek-v4.1-flash-1017'), pure.baseId('deepseek-v4.1-flash'));
  assert.equal(pure.baseId('DeepSeek V4.1 Flash'), pure.baseId('deepseek-v4.1-flash'));
});

test('cleanOpenRouter indexes by leaf id and by canonical slug', () => {
  const catalog = pure.cleanOpenRouter(OPENROUTER_FIXTURE);
  assert.equal(catalog.count, 3);
  const records = catalog.byBase.get(pure.baseId('deepseek-v4.1-flash'));
  assert.equal(records.length, 3, 'plain, dated snapshot and :batch variant share one leaf key');
  assert.ok(catalog.byCanonical.size >= 1);
});

test('a variant id loses to its plain sibling', () => {
  const records = [
    { id: 'x/model:batch', variant: true, created: 9, c: 1 },
    { id: 'x/model', variant: false, created: 1, c: 2 },
  ];
  assert.equal(pure.pickRecord(records).id, 'x/model');
});

test('deepseek-v4.1-flash resolves to none/low/high/max, as OpenRouter states', () => {
  const catalog = pure.cleanOpenRouter(OPENROUTER_FIXTURE);
  const hit = pure.matchOpenRouter(catalog, 'deepseek-v4.1-flash');
  assert.equal(hit.tier, 'exact');
  const fields = pure.deriveFields(hit.record);
  assert.deepEqual(fields.reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max' });
  assert.deepEqual(
    pure.planReasoning(fields.reasoningEfforts).map((entry) => entry.level),
    ['off', 'low', 'high', 'max'],
  );
  assert.equal(fields.contextWindow, 1048576);
  assert.equal(fields.maxTokens, 943718);
  assert.deepEqual(fields.input, ['text', 'image']);
});

test('a snapshot id picks its own snapshot entry', () => {
  const catalog = pure.cleanOpenRouter(OPENROUTER_FIXTURE);
  const hit = pure.matchOpenRouter(catalog, 'deepseek-v4.1-flash-1017');
  assert.equal(hit.tier, 'exact');
  assert.equal(hit.record.id, 'deepseek/deepseek-v4.1-flash-1017');
});

test('matchOpenRouter falls back to the canonical slug, then to fuzzy, then gives up', () => {
  const payload = {
    data: [
      {
        id: 'z-ai/glm-5.2-turbo',
        canonical_slug: 'z-ai/glm-5.2',
        context_length: 1000000,
        top_provider: { max_completion_tokens: 131072 },
        architecture: { input_modalities: ['text'] },
        reasoning: { supported_efforts: ['low', 'high'] },
        created: 5,
      },
      {
        id: 'qwen/qwen3.8-max-0902',
        context_length: 1000000,
        top_provider: { max_completion_tokens: 131072 },
        architecture: { input_modalities: ['text'] },
        reasoning: { supported_efforts: ['low', 'high'] },
        created: 5,
      },
      {
        id: 'deepseek/deepseek-v4.1-flash',
        context_length: 1048576,
        top_provider: { max_completion_tokens: 393216 },
        architecture: { input_modalities: ['text', 'image'] },
        reasoning: { supported_efforts: ['none', 'low', 'high', 'max'] },
        created: 3,
      },
    ],
  };
  const catalog = pure.cleanOpenRouter(payload);
  const aliased = pure.matchOpenRouter(catalog, 'glm-5.2');
  assert.equal(aliased.tier, 'canonical', 'the id is not in the catalog, but its canonical slug is');
  assert.equal(aliased.record.id, 'z-ai/glm-5.2-turbo');
  const snapshot = pure.matchOpenRouter(catalog, 'qwen3.8-max');
  assert.equal(snapshot.tier, 'exact', 'a dated snapshot answers the plain id');
  assert.equal(snapshot.record.id, 'qwen/qwen3.8-max-0902');
  const fuzzy = pure.matchOpenRouter(catalog, 'deepseek-v4.1-flash-fast');
  assert.equal(fuzzy.tier, 'fuzzy', 'a prefix relation is a degradation, not an exact hit');
  assert.equal(fuzzy.record.id, 'deepseek/deepseek-v4.1-flash');
  assert.equal(pure.matchOpenRouter(catalog, 'no-such-model-anywhere').tier, 'none');
});

test('models listed without efforts stay unanswered instead of being guessed', () => {
  const payload = {
    data: [
      {
        id: 'xiaomi/mimo-v2.6-flash',
        context_length: 1050000,
        top_provider: { max_completion_tokens: 131072 },
        architecture: { input_modalities: ['text', 'image'] },
      },
    ],
  };
  const fields = pure.deriveFields(pure.matchOpenRouter(pure.cleanOpenRouter(payload), 'mimo-v2.6-flash').record);
  assert.equal(fields.reasoningEfforts, undefined, 'no reasoning object means the levels are left untouched');
  assert.equal(fields.contextWindow, 1050000);
});
