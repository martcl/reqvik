import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  automaticProfile,
  HeaderChangeSchema,
  overrideOrigin,
  overrideScopeDomain,
  type ProfileDocument,
  ProfileDocumentSchema,
  pageAllowed,
  requiredPermissions,
  validateDocument,
} from '../src/model';
import { compileRules, urlRegex } from '../src/rules';

export const fixture: ProfileDocument = {
  schemaVersion: 1,
  profiles: [
    {
      id: 'example-local',
      name: 'Example local',
      scope: { pageDomains: ['www.example.com', 'www.example.localhost'] },
      rules: [
        {
          id: 'override',
          match: { origin: 'https://www.example.com', pathPrefix: '/' },
          redirectOrigin: 'https://www.example.localhost',
          requestHeaders: [
            { operation: 'set', name: 'X-Debug', value: '1' },
            { operation: 'remove', name: 'X-Remove' },
          ],
        },
      ],
    },
  ],
};
const copy = () => structuredClone(fixture);
test('Zod validates and canonicalizes versioned profile JSON', () => {
  const value = copy();
  value.profiles[0].rules[0].match.origin = 'https://WWW.EXAMPLE.COM:443/';
  assert.equal(
    validateDocument(value).profiles[0].rules[0].match.origin,
    'https://www.example.com',
  );
  assert.deepEqual(
    validateDocument(JSON.parse(JSON.stringify(fixture))),
    fixture,
  );
  assert.equal(
    ProfileDocumentSchema.safeParse({ ...fixture, schemaVersion: 2 }).success,
    false,
  );
  assert.equal(
    ProfileDocumentSchema.safeParse({ ...fixture, activations: [] }).success,
    false,
  );
  assert.equal(
    HeaderChangeSchema.safeParse({
      operation: 'set',
      name: 'X-Test',
      value: 'a\r\nb',
    }).success,
    false,
  );
  assert.equal(
    HeaderChangeSchema.safeParse({ operation: 'remove', name: 'Host' }).success,
    false,
  );
});
test('rejects unsafe or ambiguous profiles', () => {
  const mutations: Array<(doc: ProfileDocument) => void> = [
    (doc) => {
      doc.profiles[0].scope.pageDomains = ['*..example.com'];
    },
    (doc) => {
      doc.profiles[0].scope.pageDomains = ['www.example.com:443'];
    },
    (doc) => {
      doc.profiles[0].scope.pageDomains = ['www.example.com'];
    },
    (doc) => {
      doc.profiles[0].rules[0].redirectOrigin =
        'https://www.example.localhost/path';
    },
    (doc) => {
      doc.profiles[0].rules[0].redirectOrigin =
        'https://user:password@www.example.localhost';
    },
    (doc) => {
      doc.profiles[0].rules[0].redirectOrigin = 'https://www.example.com';
    },
    (doc) => {
      doc.profiles[0].rules.push({
        ...doc.profiles[0].rules[0],
        id: 'overlap',
      });
    },
    (doc) => {
      doc.profiles[0].rules.push({
        id: 'cycle',
        match: { origin: 'https://www.example.localhost', pathPrefix: '/' },
        redirectOrigin: 'https://www.example.com',
        requestHeaders: [],
      });
    },
    (doc) => {
      doc.profiles[0].rules[0].requestHeaders.push({
        operation: 'remove',
        name: 'x-debug',
      });
    },
    (doc) => {
      doc.profiles[0].rules[0].match.pathPrefix = '/?secret';
    },
    (doc) => {
      doc.profiles[0].rules[0].match.pathPrefix = '/a/../';
    },
    (doc) => {
      doc.profiles[0].rules[0].match.pathPrefix = '/æ';
    },
  ];
  for (const mutate of mutations) {
    const value = copy();
    mutate(value);
    assert.throws(() => validateDocument(value));
  }
});
test('exact origin filters exclude lookalikes, subdomains, query mentions, other ports, and schemes', () => {
  const regex = new RegExp(urlRegex('https://www.example.com', '/api/'));
  for (const url of [
    'https://www.example.com/api/a',
    'https://www.example.com:443/api/a',
  ])
    assert.ok(regex.test(url));
  for (const url of [
    'https://www.example.com.evil/api/a',
    'https://sub.www.example.com/api/a',
    'https://evil/?q=https://www.example.com/api/a',
    'https://www.example.com:8443/api/a',
    'http://www.example.com/api/a',
    'https://wwwXexampleXcom/api/a',
    'https://www.example.com/API/a',
  ])
    assert.equal(regex.test(url), false, url);
  assert.equal(
    new RegExp(urlRegex('http://localhost:8080', '/')).test(
      'http://localhost:8081/',
    ),
    false,
  );
});
test('native rules bind all actions to one tab and constrain subresources by page and initiator', () => {
  const rules = compileRules(fixture, [
    { tabId: 42, profileId: 'example-local' },
  ]);
  assert.equal(rules.length, 6);
  for (const rule of rules) {
    assert.deepEqual(rule.condition.tabIds, [42]);
    assert.equal(rule.condition.isUrlFilterCaseSensitive, true);
    if (rule.condition.excludedResourceTypes) {
      assert.deepEqual(rule.condition.topDomains, [
        'www.example.com',
        'www.example.localhost',
      ]);
      assert.deepEqual(rule.condition.initiatorDomains, [
        'www.example.com',
        'www.example.localhost',
      ]);
    }
  }
  assert.equal(
    rules.filter((rule) => rule.action.type === 'modifyHeaders').length,
    4,
  );
  assert.deepEqual(compileRules(fixture, []), []);
  assert.throws(() =>
    compileRules(fixture, [{ tabId: 42, profileId: 'missing' }]),
  );
});
test('explicit target port and default port clearing are represented in redirects', () => {
  const value = copy();
  value.profiles[0].rules[0].redirectOrigin =
    'http://www.example.localhost:8080';
  assert.deepEqual(
    compileRules(value, [{ tabId: 42, profileId: 'example-local' }])[0].action
      .redirect?.transform,
    { scheme: 'http', host: 'www.example.localhost', port: '8080' },
  );
  assert.equal(
    compileRules(fixture, [{ tabId: 42, profileId: 'example-local' }])[0].action
      .redirect?.transform?.port,
    '',
  );
});
test('allowed domain matching excludes lookalikes and browser pages', () => {
  const profile = fixture.profiles[0];
  assert.equal(pageAllowed(profile, 'https://www.example.com.evil/'), false);
  assert.equal(pageAllowed(profile, 'chrome://extensions'), false);
  assert.equal(pageAllowed(profile, 'https://sub.www.example.com/'), true);
  assert.ok(
    requiredPermissions(profile).every((pattern) => !pattern.includes(':443')),
  );
});
test('wildcard domain inputs normalize and constrain native rules and permissions', () => {
  const value = copy();
  value.profiles[0].scope.pageDomains = [
    'https://*.EXAMPLE.COM/',
    '*.example.localhost',
  ];
  const doc = validateDocument(value),
    profile = doc.profiles[0];
  assert.deepEqual(profile.scope.pageDomains, [
    '*.example.com',
    '*.example.localhost',
  ]);
  assert.equal(pageAllowed(profile, 'https://review.example.com/'), true);
  assert.equal(
    pageAllowed(profile, 'http://deep.review.example.com:8080/'),
    true,
  );
  assert.equal(pageAllowed(profile, 'https://example.com/'), true);
  assert.equal(pageAllowed(profile, 'https://example.com.evil/'), false);
  assert.equal(pageAllowed(profile, 'https://otherexample.com/'), false);
  assert.equal(
    pageAllowed(
      profile,
      'https://outside.test/?url=https://review.example.com/',
    ),
    false,
  );
  const subresource = compileRules(doc, [
    { tabId: 42, profileId: profile.id },
  ])[1];
  assert.deepEqual(subresource.condition.topDomains, [
    'example.com',
    'example.localhost',
  ]);
  assert.deepEqual(subresource.condition.initiatorDomains, [
    'example.com',
    'example.localhost',
  ]);
  assert.ok(requiredPermissions(profile).includes('https://*.example.com/*'));
  assert.ok(
    requiredPermissions(profile).every((pattern) => !pattern.includes('*.*.')),
  );
  for (const invalid of [
    '*',
    'https://*',
    '*..example.com',
    'www.*.example.com',
    'https://*.example.com/path',
    'https://*.example.com:443',
    '*.127.0.0.1',
  ]) {
    const bad = copy();
    bad.profiles[0].scope.pageDomains = [invalid, '*.example.localhost'];
    assert.throws(() => validateDocument(bad), invalid);
  }
  const duplicate = copy();
  duplicate.profiles[0].scope.pageDomains = [
    'example.com',
    '*.example.com',
    'example.localhost',
  ];
  assert.throws(() => validateDocument(duplicate));
});

function dynamicFixture(): ProfileDocument {
  const doc = copy();
  doc.profiles[0].scope.pageDomains = [
    'www.example.com',
    '*.preview.example.com',
  ];
  const rule = doc.profiles[0].rules[0];
  delete rule.redirectOrigin;
  rule.redirectPageDomain = 'https://*.preview.example.com/';
  return validateDocument(doc);
}

test('current-page overrides resolve separately in each tab, with exact target headers', () => {
  const doc = dynamicFixture();
  const targetA = 'https://www-example-com-6.preview.example.com';
  const targetB = 'http://www-example-com-7.preview.example.com:8080';
  const rules = compileRules(doc, [
    { tabId: 42, profileId: 'example-local', pageOrigin: targetA },
    { tabId: 43, profileId: 'example-local', pageOrigin: targetB },
  ]);
  assert.equal(rules.length, 12);
  for (const [tabId, target] of [
    [42, targetA],
    [43, targetB],
  ] as const) {
    const tabRules = rules.filter(
      (rule) => rule.condition.tabIds?.[0] === tabId,
    );
    const url = new URL(target);
    assert.deepEqual(tabRules[0].action.redirect?.transform, {
      scheme: url.protocol.slice(0, -1),
      host: url.hostname,
      port: url.port,
    });
    const targetHeaders = tabRules.filter(
      (rule) =>
        rule.action.type === 'modifyHeaders' &&
        new RegExp(rule.condition.regexFilter ?? '(?!)').test(`${target}/api`),
    );
    assert.equal(targetHeaders.length, 2);
    assert.ok(
      targetHeaders.every(
        (rule) =>
          !new RegExp(rule.condition.regexFilter ?? '(?!)').test(
            `${tabId === 42 ? targetB : targetA}/api`,
          ),
      ),
    );
  }
  assert.ok(
    requiredPermissions(doc.profiles[0]).includes(
      'https://*.preview.example.com/*',
    ),
  );
});

test('current-page overrides are inactive without a matching current page', () => {
  const doc = dynamicFixture();
  for (const pageOrigin of [
    undefined,
    'https://www.example.com',
    'https://preview.example.com.evil',
    'https://other.example',
  ]) {
    const rules = compileRules(doc, [
      { tabId: 42, profileId: 'example-local', pageOrigin },
    ]);
    assert.equal(rules.length, 2);
    assert.ok(rules.every((rule) => rule.action.type === 'modifyHeaders'));
  }
  doc.profiles[0].rules[0].requestHeaders = [];
  assert.doesNotThrow(() => validateDocument(doc));
  assert.deepEqual(
    compileRules(doc, [{ tabId: 42, profileId: 'example-local' }]),
    [],
  );
});

test('current-page patterns reject loops, missing scope, mixed modes and overlapping targets', () => {
  for (const mutate of [
    (doc: ProfileDocument) => {
      doc.profiles[0].rules[0].redirectPageDomain = '*.example.com';
    },
    (doc: ProfileDocument) => {
      doc.profiles[0].scope.pageDomains = ['www.example.com'];
    },
    (doc: ProfileDocument) => {
      doc.profiles[0].rules[0].redirectOrigin =
        'https://www-example-com-6.preview.example.com';
    },
    (doc: ProfileDocument) => {
      doc.profiles[0].rules[0].redirectPageDomain =
        'https://*.preview.example.com:8080';
    },
    (doc: ProfileDocument) => {
      doc.profiles[0].rules.push({
        id: 'conflict',
        match: {
          origin: 'https://www-example-com-6.preview.example.com',
          pathPrefix: '/',
        },
        requestHeaders: [
          { operation: 'set', name: 'X-Debug', value: 'conflict' },
        ],
      });
    },
  ]) {
    const doc = dynamicFixture();
    mutate(doc);
    assert.throws(() => validateDocument(doc));
  }
});

test('hostname-label wildcard overrides normalize and match only the requested preview prefix', () => {
  const doc = dynamicFixture();
  const pattern = 'www-example-com-*.preview.example.com';
  doc.profiles[0].rules[0].redirectPageDomain = `https://${pattern.toUpperCase()}/`;
  const profile = validateDocument(doc).profiles[0];
  const rule = profile.rules[0];
  assert.equal(rule.redirectPageDomain, pattern);
  assert.equal(overrideScopeDomain(pattern), '*.preview.example.com');
  for (const origin of [
    'https://www-example-com-6.preview.example.com',
    'http://www-example-com-123.preview.example.com:8080',
  ])
    assert.equal(overrideOrigin(rule, origin), origin);
  for (const origin of [
    'https://www-other-example-com-6.preview.example.com',
    'https://preview.example.com',
    'https://deep.www-example-com-6.preview.example.com',
    'https://www-example-com-6.preview.example.com.evil',
    'https://www-example-com-6Xpreview.example.com',
  ])
    assert.equal(overrideOrigin(rule, origin), undefined, origin);
  assert.ok(
    requiredPermissions(profile).includes('https://*.preview.example.com/*'),
  );
  assert.ok(
    requiredPermissions(profile).every(
      (pattern) => !pattern.includes('www-example-com-*'),
    ),
  );
  for (const invalid of [
    'www-example-**.preview.example.com',
    'www.*.example.com',
    'www-example-*.preview.example.com/path',
    'www-example-*.preview.example.com:443',
    'www-example-*.127.0.0.1',
  ]) {
    doc.profiles[0].rules[0].redirectPageDomain = invalid;
    assert.throws(() => validateDocument(doc), invalid);
  }
});

test('hostname wildcard overlap validation allows distinct prefixes and rejects intersecting rules and loops', () => {
  const doc = dynamicFixture();
  const suffix = 'preview.example.com';
  doc.profiles[0].scope.pageDomains.push('www.other.example.com');
  doc.profiles[0].rules[0].redirectPageDomain = `www-example-com-*.${suffix}`;
  const second = structuredClone(doc.profiles[0].rules[0]);
  second.id = 'other-example';
  second.match.origin = 'https://www.other.example.com';
  second.redirectPageDomain = `www-other-example-com-*.${suffix}`;
  doc.profiles[0].rules.push(second);
  assert.doesNotThrow(() => validateDocument(doc));
  second.redirectPageDomain = `www-example-com-6*.${suffix}`;
  assert.throws(() => validateDocument(doc));
  second.redirectPageDomain = `*.${suffix}`;
  assert.throws(() => validateDocument(doc));
  delete second.redirectPageDomain;
  second.match.origin = `https://www-example-com-6.${suffix}`;
  assert.throws(() => validateDocument(doc));
  second.match.origin = `https://www-other-example-com-6.${suffix}`;
  assert.doesNotThrow(() => validateDocument(doc));
  doc.profiles[0].rules[0].match.origin = `https://www-example-com-6.${suffix}`;
  assert.throws(() => validateDocument(doc));
});

test('automatic activation is opt-in and matches hostname patterns without lookalikes', () => {
  const doc = dynamicFixture();
  const url = 'https://www-example-com-6.preview.example.com/page';
  assert.equal(automaticProfile(doc, url), undefined);
  doc.profiles[0].autoActivateDomain =
    'https://WWW-EXAMPLE-COM-*.preview.example.com/';
  const normalized = validateDocument(doc);
  assert.equal(
    normalized.profiles[0].autoActivateDomain,
    'www-example-com-*.preview.example.com',
  );
  assert.equal(automaticProfile(normalized, url)?.id, 'example-local');
  assert.equal(
    automaticProfile(
      normalized,
      'http://www-example-com-123.preview.example.com:8080/page',
    )?.id,
    'example-local',
  );
  for (const value of [
    'https://www-other-example-com-6.preview.example.com',
    'https://www-example-com-6.preview.example.com.evil',
    'https://deep.www-example-com-6.preview.example.com',
    'chrome://extensions',
    'bad url',
  ])
    assert.equal(automaticProfile(normalized, value), undefined, value);
});

test('automatic activation rejects missing scopes, invalid patterns and competing profiles', () => {
  const doc = dynamicFixture();
  doc.profiles[0].autoActivateDomain = 'www-example-com-*.preview.example.com';
  const second = structuredClone(doc.profiles[0]);
  second.id = 'second';
  second.autoActivateDomain = 'www-other-example-com-*.preview.example.com';
  doc.profiles.push(second);
  assert.doesNotThrow(() => validateDocument(doc));
  for (const pattern of [
    'www-example-com-6*.preview.example.com',
    '*.preview.example.com',
    'www-example-com-*.preview.example.com/path',
  ]) {
    second.autoActivateDomain = pattern;
    assert.throws(() => validateDocument(doc));
  }
  doc.profiles.pop();
  doc.profiles[0].autoActivateDomain = '*.outside.example';
  assert.throws(() => validateDocument(doc));
  doc.profiles[0].autoActivateDomain = '';
  assert.throws(() => validateDocument(doc));
});
