/**
 * dsh-auto-meta — Client half.
 *
 * Adds one icon button ("自动填写") to every model row on the settings →
 * Models page. Clicking it resolves that row's model id against the models.dev
 * catalog and fills the row's own inputs: context window, output cap, input
 * modalities, and thinking levels.
 *
 * Two deliberate design choices, both forced by the shell:
 *
 * 1. DOM injection, not a slot. The models page registers only
 *    `settings.section` / `settings.onboarding`; there is no per-model-row
 *    slot, so a MutationObserver stamps the button onto each rendered row.
 *    Stamping is idempotent (the button carries a data attribute) and happens
 *    inside rAF, so the observer that sees our own insertion is a no-op.
 *
 * 2. Drafts, not `settings.mutate`. The editor keeps its own
 *    `expectedRevision` (captured when it loaded the namespace, refreshed only
 *    after its own successful write). A background mutate would bump the
 *    revision behind its back and make the user's next Save fail as a conflict.
 *    Filling the visible inputs instead leaves the page the single writer: the
 *    values flow through the same parser as typed input, and the user's Save
 *    persists them.
 *
 * Catalog: fetched from models.dev in the browser (the endpoint sends
 * `Access-Control-Allow-Origin: *`), compacted, and cached in IndexedDB for 24h
 * (the raw document is ~1.5 MB, over the localStorage budget). A stale cache is
 * still used when the network fails.
 */

window.__ModuleLoader__.load({
  id: 'dsh-auto-meta',
  factory(require) {
    /** Marker that also carries the insertion state; queried by the observer. */
    const MARK = 'data-dsh-auto-meta';
    const TITLE = '自动填写';
    /** Class that re-lays out a model row so our extra button stays inline. */
    const FIT_CLASS = 'dsh-auto-meta-fit';
    const CATALOG_URL = 'https://models.dev/api.json';
    const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
    const FETCH_TIMEOUT_MS = 20000;
    const STATE_MS = 1600;

    /** pi-ai's thinking levels, ascending. */
    const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    /** pi-ai's input modalities, canonical order. */
    const MODALITIES = ['text', 'image'];
    const OFF_ALIASES = new Set(['none', 'off', 'disabled', 'no', 'false']);

    /* ───────────────────────── pure logic (testable) ─────────────────────── */

    /** Tolerant id comparison key. */
    function norm(value) {
      return String(value === undefined || value === null ? '' : value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
    }

    /**
     * models.dev `reasoning_options` → pi-ai `reasoningEfforts` map.
     * A bare `toggle` carries no wire value, so it is deliberately dropped.
     */
    function toEfforts(options) {
      const list = Array.isArray(options) ? options : [];
      const effort = list.find(
        (option) => option && option.type === 'effort' && Array.isArray(option.values),
      );
      if (effort === undefined) return undefined;
      const map = {};
      for (const raw of effort.values) {
        const value = String(raw === undefined || raw === null ? '' : raw)
          .trim()
          .toLowerCase();
        if (value === '') continue;
        if (OFF_ALIASES.has(value) || value === 'off') {
          map.off = null;
          continue;
        }
        if (THINKING_LEVELS.includes(value)) map[value] = value;
      }
      if (!Object.keys(map).some((level) => level !== 'off')) return undefined;
      return map;
    }

    /** The UI rows a reasoning map implies, in escalation order. */
    function planReasoning(efforts) {
      if (efforts === undefined || efforts === null) return undefined;
      const levels = THINKING_LEVELS.filter((level) => Object.prototype.hasOwnProperty.call(efforts, level));
      if (levels.length === 0) return undefined;
      return levels.map((level) => ({
        level,
        wire: efforts[level] === null ? null : String(efforts[level]),
      }));
    }

    /** Normalize one compact catalog record into the fields the page needs. */
    function deriveFields(record) {
      const fields = {};
      if (record === undefined || record === null) return fields;
      if (Number.isInteger(record.c) && record.c > 0) fields.contextWindow = record.c;
      if (Number.isInteger(record.o) && record.o > 0) fields.maxTokens = record.o;
      const inputs = Array.isArray(record.i) ? record.i : [];
      if (inputs.length > 0) fields.input = MODALITIES.filter((modality) => inputs.includes(modality));
      const efforts = toEfforts(record.r);
      if (efforts !== undefined) fields.reasoningEfforts = efforts;
      return fields;
    }

    /** Index a compacted catalog. Lookups are then O(1) on the model id. */
    function buildIndex(providers) {
      const byProvider = new Map();
      const byModel = new Map();
      const source = providers !== null && typeof providers === 'object' ? providers : {};
      for (const [providerId, rawProvider] of Object.entries(source)) {
        if (rawProvider === null || typeof rawProvider !== 'object') continue;
        const provider = {
          id: providerId,
          name: rawProvider.n,
          aliases: new Set([norm(providerId), norm(rawProvider.n)]),
          models: new Map(),
        };
        byProvider.set(providerId, provider);
        for (const [key, rawModel] of Object.entries(rawProvider.m || {})) {
          if (rawModel === null || typeof rawModel !== 'object') continue;
          const record = {
            providerId,
            key,
            name: rawModel.n,
            c: rawModel.c,
            o: rawModel.o,
            i: Array.isArray(rawModel.i) ? rawModel.i : [],
            r: Array.isArray(rawModel.r) ? rawModel.r : [],
            canonical: typeof rawModel.cid === 'string' ? rawModel.cid : null,
          };
          provider.models.set(key, record);
          const lookups = new Set([norm(key), norm(record.canonical)]);
          for (const lookup of lookups) {
            if (lookup === '') continue;
            const bucket = byModel.get(lookup);
            if (bucket === undefined) byModel.set(lookup, [record]);
            else if (!bucket.includes(record)) bucket.push(record);
          }
        }
      }
      return { byProvider, byModel, providerCount: byProvider.size, modelCount: byModel.size };
    }

    /** Find the models.dev provider a configured route id names, tolerantly. */
    function findProvider(index, routeId) {
      const key = norm(routeId);
      if (key === '') return undefined;
      for (const provider of index.byProvider.values()) {
        if (provider.aliases.has(key)) return provider;
      }
      return undefined;
    }

    /** Most frequently declared canonical id among same-named records. */
    function pickCanonical(candidates) {
      const tally = new Map();
      for (const record of candidates) {
        if (record.canonical === null) continue;
        tally.set(record.canonical, (tally.get(record.canonical) || 0) + 1);
      }
      let best;
      for (const [canonical, count] of tally) {
        if (best === undefined || count > best.count) best = { canonical, count };
      }
      return best === undefined ? undefined : best.canonical;
    }

    /** The vendor's own record for a canonical `vendor/model` id. */
    function findVendorRecord(index, canonical, modelId) {
      const parts = String(canonical).split('/');
      const vendor = index.byProvider.get(parts[0]);
      if (vendor === undefined) return undefined;
      const slug = parts.slice(1).join('/');
      const wanted = new Set([norm(modelId), norm(slug)].filter((key) => key !== ''));
      for (const record of vendor.models.values()) {
        if (wanted.has(norm(record.key)) || norm(record.canonical) === norm(canonical)) return record;
      }
      return undefined;
    }

    /**
     * Resolve one configured model id to its authoritative metadata.
     * Tiers, strongest first: the route's own provider, the canonical vendor,
     * then a cross-provider consensus.
     */
    function resolveModel(index, routeId, modelId) {
      const key = norm(modelId);
      const candidates = index.byModel.get(key) || [];
      const canonical = pickCanonical(candidates);
      const route = findProvider(index, routeId);
      if (route !== undefined) {
        const direct = route.models.get(modelId) || route.models.get(String(modelId).toLowerCase());
        const record =
          direct ||
          [...route.models.values()].find((entry) => norm(entry.key) === key);
        if (record !== undefined) {
          return { tier: 'route', source: route.id, record, candidates, canonical: canonical || record.canonical };
        }
      }
      if (canonical !== undefined) {
        const record = findVendorRecord(index, canonical, modelId);
        if (record !== undefined) return { tier: 'vendor', source: record.providerId, record, candidates, canonical };
      }
      if (candidates.length > 0) {
        return { tier: 'consensus', source: 'consensus:' + candidates.length, candidates, canonical: canonical || null };
      }
      return { tier: 'none', source: null, candidates: [], canonical: null };
    }

    /** Modal value of one field across carriers; ties keep first-seen order. */
    function modalOf(records, pick, accept) {
      const tally = new Map();
      let total = 0;
      for (const record of records) {
        const value = pick(record);
        if (!accept(value)) continue;
        total += 1;
        const bucket = tally.get(value);
        if (bucket === undefined) tally.set(value, { value, count: 1 });
        else bucket.count += 1;
      }
      let top;
      for (const bucket of tally.values()) {
        if (top === undefined || bucket.count > top.count) top = bucket;
      }
      return { top, total };
    }

    /**
     * Derive fields from several disagreeing carriers: a value is only taken
     * when a majority of the carriers that declare it agree.
     */
    function consensusFields(candidates) {
      const fields = {};
      const agreement = {};
      if (candidates.length === 0) return { fields, agreement };

      const numeric = [
        ['contextWindow', (record) => record.c],
        ['maxTokens', (record) => record.o],
      ];
      for (const pair of numeric) {
        const field = pair[0];
        const pick = pair[1];
        const picked = modalOf(candidates, pick, (value) => Number.isInteger(value) && value > 0);
        if (picked.top !== undefined && picked.top.count * 2 >= picked.total) {
          fields[field] = picked.top.value;
          agreement[field] = picked.top.count + '/' + picked.total;
        }
      }

      const imageCarriers = candidates.filter((record) => record.i.includes('image')).length;
      fields.input = imageCarriers * 2 >= candidates.length ? ['text', 'image'] : ['text'];
      agreement.input = imageCarriers + '/' + candidates.length;

      const shown = new Map();
      for (const record of candidates) {
        const map = toEfforts(record.r);
        if (map === undefined) continue;
        const key = THINKING_LEVELS.filter((level) => Object.prototype.hasOwnProperty.call(map, level)).join(',');
        const bucket = shown.get(key);
        if (bucket === undefined) shown.set(key, { map, count: 1 });
        else bucket.count += 1;
      }
      let best;
      for (const bucket of shown.values()) {
        if (best === undefined || bucket.count > best.count) best = bucket;
      }
      if (best !== undefined && best.count * 2 >= candidates.length) {
        fields.reasoningEfforts = best.map;
        agreement.reasoningEfforts = best.count + '/' + candidates.length;
      }
      return { fields, agreement };
    }

    /** Fields plus provenance for one resolved model id. */
    function resolveMeta(index, modelId, routeId) {
      const resolved = resolveModel(index, routeId, modelId);
      if (resolved.tier === 'none') return { fields: {}, agreement: {}, tier: 'none', source: null };
      if (resolved.tier === 'consensus') {
        const shared = consensusFields(resolved.candidates);
        return {
          fields: shared.fields,
          agreement: shared.agreement,
          tier: resolved.tier,
          source: resolved.source,
        };
      }
      return {
        fields: deriveFields(resolved.record),
        agreement: {},
        tier: resolved.tier,
        source: resolved.source,
      };
    }

    /* ────────────────────────────── catalog ─────────────────────────────── */

    let memoryCache;
    let indexPromise;

    function openDb() {
      return new Promise((resolve) => {
        let request;
        try {
          request = indexedDB.open('dsh-auto-meta', 1);
        } catch (error) {
          resolve(null);
          return;
        }
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
    }

    async function cacheRead() {
      if (memoryCache !== undefined) return memoryCache;
      const db = await openDb();
      if (db === null) return undefined;
      const stored = await new Promise((resolve) => {
        const request = db.transaction('kv', 'readonly').objectStore('kv').get('catalog');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
      });
      if (stored && typeof stored === 'object' && stored.providers) memoryCache = stored;
      return memoryCache;
    }

    async function cacheWrite(entry) {
      memoryCache = entry;
      const db = await openDb();
      if (db === null) return;
      try {
        db.transaction('kv', 'readwrite').objectStore('kv').put(entry, 'catalog');
      } catch (error) {
        /* a full quota must not break the fill */
      }
    }

    /** Keep only the fields the page needs; the raw document is ~1.5 MB. */
    function compact(doc) {
      const providers = {};
      for (const [providerId, provider] of Object.entries(doc || {})) {
        if (provider === null || typeof provider !== 'object') continue;
        const models = {};
        for (const [key, model] of Object.entries(provider.models || {})) {
          if (model === null || typeof model !== 'object') continue;
          models[key] = {
            n: typeof model.name === 'string' ? model.name : key,
            c: model.limit && Number.isInteger(model.limit.context) ? model.limit.context : undefined,
            o: model.limit && Number.isInteger(model.limit.output) ? model.limit.output : undefined,
            i: Array.isArray(model.modalities && model.modalities.input) ? model.modalities.input : [],
            r: Array.isArray(model.reasoning_options) ? model.reasoning_options : [],
            cid: typeof model.canonical_model_id === 'string' ? model.canonical_model_id : undefined,
          };
        }
        providers[providerId] = { n: typeof provider.name === 'string' ? provider.name : providerId, m: models };
      }
      return providers;
    }

    async function fetchCatalog() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(CATALOG_URL, {
          signal: controller.signal,
          cache: 'no-cache',
          credentials: 'omit',
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const doc = await response.json();
        const entry = { fetchedAt: Date.now(), providers: compact(doc) };
        await cacheWrite(entry);
        return entry;
      } finally {
        clearTimeout(timer);
      }
    }

    /** Compact catalog: fresh cache → network → stale cache. */
    async function readCatalog() {
      const cached = await cacheRead();
      const fresh = cached !== undefined && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
      if (fresh) return cached;
      try {
        return await fetchCatalog();
      } catch (error) {
        if (cached !== undefined) return cached;
        throw error;
      }
    }

    function catalogIndex() {
      if (indexPromise === undefined) {
        indexPromise = readCatalog()
          .then((entry) => buildIndex(entry.providers))
          .catch((error) => {
            indexPromise = undefined;
            throw error;
          });
      }
      return indexPromise;
    }

    /* ──────────────────────────── DOM driving ───────────────────────────── */

    /** Set a React-controlled input's value through its own setter + event. */
    function setInput(element, value) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setSelect(element, value) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /** Yield past React's synchronous commit. */
    function tick() {
      return new Promise((resolve) => setTimeout(resolve, 0));
    }

    /**
     * One thinking-level row. The group also renders a header row carrying the
     * column captions; it is marked `aria-hidden` and must not be counted (it
     * has no select, and counting it would shift every row by one).
     */
    const ROW_SELECTOR = 'div[class*="modelReasoningRow"]:not([aria-hidden="true"])';

    /** The model row a chevron button belongs to. */
    function rowOf(chevron) {
      return chevron.parentElement;
    }

    /** The row's own model id input. */
    function modelIdOf(row) {
      const input = row.querySelector('input[type="text"]');
      return input === null ? '' : String(input.value || '').trim();
    }

    /** The expanded "模型选项" panel, expanding it first when collapsed. */
    async function openPanel(chevron, row) {
      const entry = row.parentElement;
      if (entry === null) return undefined;
      let panel = entry.children.length > 1 ? entry.children[1] : undefined;
      if (panel === undefined || panel.querySelector('input') === null) {
        chevron.click();
        await tick();
        panel = entry.children.length > 1 ? entry.children[1] : undefined;
      }
      return panel;
    }

    /** Short-lived visual + tooltip feedback; the tooltip explains a miss. */
    function flash(button, state, message) {
      button.dataset.state = state;
      button.title = message === undefined ? TITLE : TITLE + '：' + message;
      const previous = button.__autoMetaTimer;
      if (previous !== undefined) clearTimeout(previous);
      button.__autoMetaTimer = setTimeout(() => {
        delete button.dataset.state;
        button.title = TITLE;
      }, STATE_MS);
    }

    /** The two capacity inputs: context window first, output cap second. */
    function numericInputs(panel) {
      const labelled = (pattern) =>
        [...panel.querySelectorAll('input')].find((input) => {
          const label = input.getAttribute('aria-label') || '';
          return label.indexOf(pattern) !== -1;
        });
      return {
        contextWindow: labelled('上下文'),
        maxTokens: labelled('最大输出'),
      };
    }

    function reasoningGroup(panel) {
      const groups = [...panel.querySelectorAll('[role="group"]')];
      return groups.find((group) => group.querySelector('button[role="switch"]') !== null) || groups[0];
    }

    /** First button in scope whose label matches; the group also holds a help button. */
    function buttonByLabel(scope, pattern) {
      return [...scope.querySelectorAll('button')].find((button) => {
        const label = (button.getAttribute('aria-label') || '') + ' ' + (button.textContent || '');
        return pattern.test(label);
      });
    }

    /** The level values one row's select offers right now. */
    function levelOptions(select) {
      return select === null ? [] : [...select.options].map((option) => option.value);
    }

    /** The level each row currently holds, in row order. */
    function currentLevels(group) {
      return [...group.querySelectorAll(ROW_SELECTOR)].map((row) => {
        const select = row.querySelector('select');
        return select === null ? null : select.value;
      });
    }

    /** Grow or shrink the level rows to `count`, one click at a time. */
    async function ensureRows(group, count) {
      for (let guard = 0; guard < 16; guard += 1) {
        const rows = [...group.querySelectorAll(ROW_SELECTOR)];
        if (rows.length === count) return true;
        if (rows.length > count) {
          const remove = buttonByLabel(rows[rows.length - 1], /删除/);
          if (remove === undefined) return false;
          remove.click();
        } else {
          const add = buttonByLabel(group, /添加/);
          if (add === undefined) return false;
          add.click();
        }
        await tick();
      }
      return false;
    }

    /** The first level in `options` that no row holds and that `wanted` does not need. */
    function spareLevel(options, values, wanted) {
      return options.find((option) => wanted.indexOf(option) === -1 && values.indexOf(option) === -1);
    }

    /**
     * Put one wanted level on each row. A row's select only offers the levels
     * the other rows do not hold, so rows are placed one at a time whenever
     * their target is free; a row blocking another's target parks on a spare
     * level first, which breaks the cycle and frees the target.
     */
    async function assignLevels(group, wanted) {
      const rowSelect = (index) => {
        const row = [...group.querySelectorAll(ROW_SELECTOR)][index];
        return row === undefined ? null : row.querySelector('select');
      };
      for (let guard = 0; guard < 64; guard += 1) {
        const values = currentLevels(group);
        const wrong = values.findIndex((value, index) => value !== wanted[index]);
        if (wrong === -1) return true;
        let moved = false;
        // Place any row whose target nobody holds: that never takes a choice away.
        for (let i = 0; i < wanted.length && !moved; i += 1) {
          const live = currentLevels(group);
          if (live[i] === wanted[i]) continue;
          const holder = live.indexOf(wanted[i]);
          if (holder !== -1 && holder !== i) continue;
          const select = rowSelect(i);
          if (select === null || levelOptions(select).indexOf(wanted[i]) === -1) continue;
          setSelect(select, wanted[i]);
          await tick();
          moved = true;
        }
        if (moved) continue;
        // Everyone left is blocked: park a blocked row on a spare level.
        for (let i = 0; i < wanted.length && !moved; i += 1) {
          const live = currentLevels(group);
          if (live[i] === wanted[i]) continue;
          const select = rowSelect(i);
          if (select === null) continue;
          const spare = spareLevel(levelOptions(select), live, wanted);
          if (spare === undefined) continue;
          setSelect(select, spare);
          await tick();
          moved = true;
        }
        if (!moved) return false;
      }
      return currentLevels(group).every((value, index) => value === wanted[index]);
    }

    /** Fill the thinking-level rows: switch on, match the count, set levels and wire values. */
    async function fillReasoning(panel, efforts) {
      const plan = planReasoning(efforts);
      if (plan === undefined || plan.length === 0) return false;
      const group = reasoningGroup(panel);
      if (group === undefined) return false;
      const toggle = group.querySelector('button[role="switch"]');
      if (toggle !== null && toggle.getAttribute('aria-checked') !== 'true') {
        toggle.click();
        await tick();
      }
      if (!(await ensureRows(group, plan.length))) return false;
      const levels = plan.map((entry) => entry.level);
      if (!(await assignLevels(group, levels))) return false;
      for (let i = 0; i < plan.length; i += 1) {
        const rows = [...group.querySelectorAll(ROW_SELECTOR)];
        const row = rows[i];
        if (row === undefined) return false;
        const wire = row.querySelector('input[type="text"]');
        if (wire === null) continue;
        const value = plan[i].wire === null ? '' : plan[i].wire;
        if (wire.value !== value) {
          setInput(wire, value);
          await tick();
        }
      }
      return true;
    }

    /** Fill the input-modality checkboxes. */
    function fillInputs(panel, inputs) {
      const fieldset = panel.querySelector('fieldset');
      if (fieldset === null) return false;
      const boxes = [...fieldset.querySelectorAll('input[type="checkbox"]')];
      if (boxes.length === 0) return false;
      const want = new Set(Array.isArray(inputs) ? inputs : ['text']);
      const desired = MODALITIES.map((modality, index) => ({
        box: boxes[index],
        checked: want.has(modality),
      })).filter((item) => item.box !== undefined);
      // Check before unchecking: a group keeps at least one box selected, so
      // removing the last unwanted one first would be refused.
      for (const item of desired) {
        if (item.checked && !item.box.checked && !item.box.disabled) item.box.click();
      }
      for (const item of desired) {
        if (!item.checked && item.box.checked && !item.box.disabled) item.box.click();
      }
      return true;
    }

    /** Fill one row from its model id; returns a short outcome string. */
    async function fillRow(row) {
      const modelId = modelIdOf(row);
      if (modelId === '') return 'empty';
      const index = await catalogIndex();
      const meta = resolveMeta(index, modelId, '');
      const fields = meta.fields;
      if (Object.keys(fields).length === 0) return 'miss';
      const chevron = row.querySelector('button[aria-expanded]');
      if (chevron === null) return 'miss';
      const panel = await openPanel(chevron, row);
      if (panel === undefined) return 'miss';
      const numbers = numericInputs(panel);
      if (fields.contextWindow !== undefined && numbers.contextWindow) {
        setInput(numbers.contextWindow, String(fields.contextWindow));
      }
      if (fields.maxTokens !== undefined && numbers.maxTokens) {
        setInput(numbers.maxTokens, String(fields.maxTokens));
      }
      if (fields.input !== undefined) fillInputs(panel, fields.input);
      if (fields.reasoningEfforts !== undefined) await fillReasoning(panel, fields.reasoningEfforts);
      return 'ok';
    }

    /* ───────────────────────────── injection ────────────────────────────── */

    const ICON_PATH =
      'M12 3v2.2M12 18.8V21M4.4 4.4l1.6 1.6M18 18l1.6 1.6M3 12h2.2M18.8 12H21M4.4 19.6L6 18M18 6l1.6-1.6M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z';

    function makeButton(template) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = template.className;
      button.title = TITLE;
      button.setAttribute('aria-label', TITLE);
      button.setAttribute(MARK, 'idle');
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      for (const pair of [
        ['viewBox', '0 0 24 24'],
        ['width', '14'],
        ['height', '14'],
        ['fill', 'none'],
        ['stroke', 'currentColor'],
        ['stroke-width', '1.7'],
        ['stroke-linecap', 'round'],
        ['stroke-linejoin', 'round'],
        ['aria-hidden', 'true'],
      ]) {
        svg.setAttribute(pair[0], pair[1]);
      }
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', ICON_PATH);
      svg.appendChild(path);
      button.appendChild(svg);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.dataset.state === 'busy') return;
        const row = rowOf(button.nextElementSibling || button);
        if (row === null) return;
        flash(button, 'busy');
        fillRow(row).then(
          (outcome) => {
            if (outcome === 'ok') flash(button, 'ok', '已填入');
            else if (outcome === 'empty') flash(button, 'miss', '先填写模型 ID');
            else if (outcome === 'miss') flash(button, 'miss', 'models.dev 未收录该模型');
            else flash(button, 'error', '该行缺少可填写项');
          },
          () => flash(button, 'error', '参数获取失败'),
        );
      });
      return button;
    }

    /**
     * Keep the row on one line now that it holds one more control than the
     * shell designed for. The row is a `grid` with a fixed track count (two
     * flexible tracks for the text inputs, then `auto` tracks for the buttons),
     * so a fifth child spills onto an implicit second row and pushes the delete
     * button down. When that is detected, the row is switched to a flex line
     * whose flexible tracks the inputs share — the extra button then costs the
     * two inputs ~34px instead of a wrapped row.
     */
    function needsFit(display, trackCount, childCount, flexWrap) {
      if (display.indexOf('grid') !== -1) return trackCount > 0 && childCount > trackCount;
      if (display.indexOf('flex') !== -1) return flexWrap === 'wrap';
      return false;
    }

    function fitRow(row) {
      const style = getComputedStyle(row);
      const tracks = String(style.gridTemplateColumns || '').trim();
      const trackCount = tracks === '' || tracks === 'none' ? 0 : tracks.split(/\s+/).length;
      if (needsFit(style.display, trackCount, row.children.length, style.flexWrap)) {
        row.classList.add(FIT_CLASS);
      }
    }

    /** Stamp the button onto every rendered model row (idempotent). */
    function scan() {
      const entries = document.querySelectorAll('[class*="modelEntry"]');
      for (const entry of entries) {
        if (entry.querySelector('[' + MARK + ']') !== null) continue;
        const chevron = entry.querySelector('button[aria-expanded]');
        if (chevron === null) continue;
        const row = chevron.parentElement;
        if (row === null || row.querySelector('input[type="text"]') === null) continue;
        row.insertBefore(makeButton(chevron), chevron);
        fitRow(row);
      }
    }

    const STYLE_ID = 'dsh-auto-meta/style';
    function injectStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [
        'button[' + MARK + '][data-state="ok"]{color:#2f9e44}',
        'button[' + MARK + '][data-state="miss"]{color:#e8590c}',
        'button[' + MARK + '][data-state="error"]{color:#e03131}',
        'button[' + MARK + '][data-state="busy"]{opacity:.45;cursor:progress}',
        // Row re-layout: only applied when the shell's own grid would wrap.
        // The selectors outrank the shell's module classes so the row, not the
        // button, is what gives up the ~34px the extra control needs.
        'div[class*="modelRow"].' + FIT_CLASS + '{display:flex;align-items:center;gap:6px;flex-wrap:nowrap}',
        'div[class*="modelRow"].' + FIT_CLASS + ' > input{flex:1 1 0;min-width:0;width:auto}',
        'div[class*="modelRow"].' + FIT_CLASS + ' > input:first-of-type{flex:1.4 1 0}',
      ].join('\n');
      document.head.appendChild(style);
    }

    /* ─────────────────────────────── plugin ─────────────────────────────── */

    return {
      /**
       * Watch for rendered model rows and stamp one button on each.
       * No inject list: the shell's DOM is the only surface used.
       */
      apply(ctx) {
        injectStyle();
        let frame = 0;
        let stopped = false;
        const schedule = () => {
          if (stopped || frame !== 0) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            if (!stopped) scan();
          });
        };
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
        scan();
        const dispose = () => {
          stopped = true;
          observer.disconnect();
          if (frame !== 0) cancelAnimationFrame(frame);
          const style = document.getElementById(STYLE_ID);
          if (style !== null) style.remove();
        };
        ctx.effect(() => dispose);
      },
      /** Stable seam for the unit tests; never used by the shell. */
      __pure: {
        norm,
        toEfforts,
        planReasoning,
        deriveFields,
        buildIndex,
        findProvider,
        pickCanonical,
        resolveModel,
        consensusFields,
        resolveMeta,
        needsFit,
        compact,
      },
    };
  },
});
